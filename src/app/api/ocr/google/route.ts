import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isApiRequestAuthorized, unauthorizedJson } from "@/lib/api-auth";
import { AI_AUTO_RECOGNITION_ENABLED } from "@/lib/ai-feature";
import { recordMonthlyOcrRequest } from "@/lib/ocr-usage-server";

export const dynamic = "force-dynamic";

const GOOGLE_VISION_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";
const MAX_IMAGE_DATA_URL_LENGTH = 4_000_000;
const MAX_RESULT_REGIONS = 120;

type Vertex = {
  x?: number;
  y?: number;
};

type BoundingPoly = {
  vertices?: Vertex[];
  normalizedVertices?: Vertex[];
};

type DetectedBreak = {
  type?: "UNKNOWN" | "SPACE" | "SURE_SPACE" | "EOL_SURE_SPACE" | "HYPHEN" | "LINE_BREAK";
};

type SymbolAnnotation = {
  text?: string;
  confidence?: number;
  property?: {
    detectedBreak?: DetectedBreak;
  };
};

type WordAnnotation = {
  symbols?: SymbolAnnotation[];
  confidence?: number;
};

type ParagraphAnnotation = {
  boundingBox?: BoundingPoly;
  confidence?: number;
  words?: WordAnnotation[];
};

type GoogleVisionResponse = {
  responses?: Array<{
    fullTextAnnotation?: {
      text?: string;
      pages?: Array<{
        width?: number;
        height?: number;
        blocks?: Array<{
          paragraphs?: ParagraphAnnotation[];
        }>;
      }>;
    };
    error?: {
      code?: number;
      message?: string;
    };
  }>;
  error?: {
    code?: number;
    message?: string;
  };
};

function getParagraphText(paragraph: ParagraphAnnotation) {
  let text = "";

  for (const word of paragraph.words ?? []) {
    for (const symbol of word.symbols ?? []) {
      text += symbol.text ?? "";
      const breakType = symbol.property?.detectedBreak?.type;

      if (breakType === "SPACE" || breakType === "SURE_SPACE") {
        text += " ";
      } else if (breakType === "EOL_SURE_SPACE" || breakType === "LINE_BREAK") {
        text += "\n";
      } else if (breakType === "HYPHEN") {
        text += "-\n";
      }
    }
  }

  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function getParagraphConfidence(paragraph: ParagraphAnnotation) {
  if (Number.isFinite(paragraph.confidence)) {
    return Math.round(Math.max(0, Math.min(1, paragraph.confidence ?? 0)) * 100);
  }

  const confidences = (paragraph.words ?? [])
    .map((word) => word.confidence)
    .filter((confidence): confidence is number => Number.isFinite(confidence));

  if (confidences.length === 0) return 0;
  return Math.round(
    (confidences.reduce((sum, confidence) => sum + confidence, 0) / confidences.length) *
      100,
  );
}

function getBoundingRect(
  boundingPoly: BoundingPoly | undefined,
  pageWidth: number,
  pageHeight: number,
) {
  const pixelVertices = boundingPoly?.vertices?.filter(
    (vertex) => Number.isFinite(vertex.x) || Number.isFinite(vertex.y),
  );
  const vertices =
    pixelVertices && pixelVertices.length > 0
      ? pixelVertices.map((vertex) => ({
          x: vertex.x ?? 0,
          y: vertex.y ?? 0,
        }))
      : (boundingPoly?.normalizedVertices ?? []).map((vertex) => ({
          x: (vertex.x ?? 0) * pageWidth,
          y: (vertex.y ?? 0) * pageHeight,
        }));

  if (vertices.length === 0) return undefined;

  const left = Math.max(0, Math.min(...vertices.map((vertex) => vertex.x)));
  const top = Math.max(0, Math.min(...vertices.map((vertex) => vertex.y)));
  const right = Math.min(pageWidth, Math.max(...vertices.map((vertex) => vertex.x)));
  const bottom = Math.min(pageHeight, Math.max(...vertices.map((vertex) => vertex.y)));

  if (right <= left || bottom <= top) return undefined;

  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
  };
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAuthorized(request)) {
    return unauthorizedJson();
  }

  if (!AI_AUTO_RECOGNITION_ENABLED) {
    return NextResponse.json(
      { error: "Google Vision OCR 기능이 비활성화되어 있습니다." },
      { status: 403 },
    );
  }

  const apiKey = process.env.GOOGLE_CLOUD_VISION_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: "GOOGLE_CLOUD_VISION_API_KEY가 설정되지 않았습니다." },
      { status: 503 },
    );
  }

  try {
    const body = (await request.json()) as { imageDataUrl?: string };
    const imageDataUrl = body.imageDataUrl?.trim() ?? "";
    const imageMatch = imageDataUrl.match(
      /^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/,
    );

    if (!imageMatch || imageDataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
      return NextResponse.json(
        { error: "Google Vision OCR 이미지 데이터가 올바르지 않거나 너무 큽니다." },
        { status: 400 },
      );
    }

    let usage;
    try {
      usage = (await recordMonthlyOcrRequest()).usage;
    } catch (usageError) {
      console.error("[ocr-usage] Failed to record OCR request.", usageError);
    }

    const googleResponse = await fetch(GOOGLE_VISION_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        requests: [
          {
            image: {
              content: imageMatch[1].replace(/\s+/g, ""),
            },
            features: [
              {
                type: "DOCUMENT_TEXT_DETECTION",
              },
            ],
            imageContext: {
              languageHints: ["ko", "en"],
            },
          },
        ],
      }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]),
    });

    const responseBody = (await googleResponse.json()) as GoogleVisionResponse;
    const annotation = responseBody.responses?.[0];
    const googleError = responseBody.error ?? annotation?.error;

    if (!googleResponse.ok || googleError) {
      console.error("[google-vision-ocr] Request failed.", {
        status: googleResponse.status,
        code: googleError?.code,
        message: googleError?.message,
      });
      return NextResponse.json(
        { error: googleError?.message || "Google Vision OCR 요청에 실패했습니다." },
        { status: 502 },
      );
    }

    const lines = (annotation?.fullTextAnnotation?.pages ?? [])
      .flatMap((page) => {
        const pageWidth = Math.max(1, page.width ?? 1);
        const pageHeight = Math.max(1, page.height ?? 1);

        return (page.blocks ?? []).flatMap((block) =>
          (block.paragraphs ?? []).flatMap((paragraph) => {
            const text = getParagraphText(paragraph);
            const rect = getBoundingRect(paragraph.boundingBox, pageWidth, pageHeight);
            if (!text || !rect) return [];

            return [
              {
                text: text.replace(/\s+/g, " ").trim().slice(0, 500),
                confidence: getParagraphConfidence(paragraph),
                mergedFrom: Math.max(1, text.split("\n").filter(Boolean).length),
                rect,
              },
            ];
          }),
        );
      })
      .sort((left, right) => left.rect.y - right.rect.y || left.rect.x - right.rect.x)
      .slice(0, MAX_RESULT_REGIONS);

    console.info("[google-vision-ocr] Recognition succeeded.", {
      regions: lines.length,
    });

    return NextResponse.json({
      provider: "google-vision",
      fullText: annotation?.fullTextAnnotation?.text?.trim() ?? "",
      lines,
      usage,
    });
  } catch (error) {
    const message =
      error instanceof Error && error.name === "TimeoutError"
        ? "Google Vision OCR 요청 시간이 초과되었습니다."
        : error instanceof Error
          ? error.message
          : "Google Vision OCR 처리 중 오류가 발생했습니다.";
    console.error("[google-vision-ocr] Failed.", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
