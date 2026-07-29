import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isApiRequestAuthorized, unauthorizedJson } from "@/lib/api-auth";
import { AI_AUTO_RECOGNITION_ENABLED } from "@/lib/ai-feature";

export const dynamic = "force-dynamic";

const MODEL = "gpt-5.4-nano";
const MAX_REGIONS = 80;
const MAX_CANDIDATES_PER_REGION = 6;
const MAX_IMAGE_DATA_URL_LENGTH = 3_500_000;

type Candidate = {
  id: string;
  key: string;
  matchType: string;
  linkedCount: number;
  translations: Record<string, string>;
};

type SuggestionRegion = {
  id: string;
  label?: string;
  text: string;
  ocrConfidence?: number;
  bbox: { x: number; y: number; width: number; height: number };
  candidates: Candidate[];
};

type SuggestionRequest = {
  imageDataUrl?: string;
  screen?: {
    name?: string;
    group?: string;
    baseLanguage?: string;
    imageWidth?: number;
    imageHeight?: number;
  };
  regions?: SuggestionRegion[];
};

type OpenAiResponse = {
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
  };
};

function getOutputText(response: OpenAiResponse) {
  for (const output of response.output ?? []) {
    for (const content of output.content ?? []) {
      if (content.type === "output_text" && content.text) return content.text;
    }
  }

  return undefined;
}

function isValidRegion(region: SuggestionRegion) {
  return (
    typeof region.id === "string" &&
    region.id.length > 0 &&
    typeof region.text === "string" &&
    region.text.length <= 500 &&
    Array.isArray(region.candidates) &&
    region.candidates.length <= MAX_CANDIDATES_PER_REGION
  );
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAuthorized(request)) {
    return unauthorizedJson();
  }

  if (!AI_AUTO_RECOGNITION_ENABLED) {
    return NextResponse.json(
      { error: "AI 자동 인식 기능이 비활성화되어 있습니다." },
      { status: 403 },
    );
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY가 설정되지 않았습니다." },
      { status: 503 },
    );
  }

  try {
    const body = (await request.json()) as SuggestionRequest;
    const regions = body.regions ?? [];

    if (
      regions.length === 0 ||
      regions.length > MAX_REGIONS ||
      !regions.every(isValidRegion) ||
      (body.imageDataUrl && body.imageDataUrl.length > MAX_IMAGE_DATA_URL_LENGTH)
    ) {
      return NextResponse.json({ error: "AI 후보 요청 데이터가 올바르지 않습니다." }, { status: 400 });
    }

    const allowedCandidateIds = new Map(
      regions.map((region) => [region.id, new Set(region.candidates.map((candidate) => candidate.id))]),
    );
    const promptData = {
      screen: {
        name: body.screen?.name ?? "",
        group: body.screen?.group ?? "",
        baseLanguage: body.screen?.baseLanguage ?? "",
        imageWidth: body.screen?.imageWidth ?? null,
        imageHeight: body.screen?.imageHeight ?? null,
      },
      regions: regions.map((region) => ({
        id: region.id,
        label: region.label ?? "",
        recognizedText: region.text,
        ocrConfidence: region.ocrConfidence ?? null,
        bbox: region.bbox,
        candidates: region.candidates,
      })),
    };

    const content: Array<Record<string, unknown>> = [
      {
        type: "input_text",
        text: [
          "Analyze the supplied UI screenshot and choose translation keys for OCR regions.",
          "The screenshot has red rectangles with numeric labels. Match each prompt region to the red rectangle with the same label.",
          "First classify whether each OCR box is real localizable UI text.",
          "regionType=ui_text only for readable interface copy such as headings, descriptions, field labels, buttons, tabs, notices, and links.",
          "Short button labels such as Yes, No, OK, or Cancel and page titles such as Age Verification are ui_text.",
          "Do not classify a page heading as a logo merely because it is large or stylized.",
          "Use icon for close, chevron, arrow, menu, or other symbol-only controls even when OCR reads them as letters such as X or characters such as >.",
          "Use logo for brand marks or logo lettering, status_bar for device time/status indicators, illustration_noise for faces, eyes, hair, clothing, borders, or artwork falsely detected as text, duplicate for an overlapping or broad OCR box whose visible text is already covered by more accurate boxes, and uncertain when the screenshot does not support a reliable classification.",
          "Set keepRegion=true only for regionType=ui_text. Logos, device status text, decorative image text, and illustration noise must be excluded.",
          "When multiple OCR boxes overlap and show the same visible text, keep only the smallest accurate box and classify the excluded box as duplicate.",
          "When one broad OCR box combines text that is already covered by separate accurate child boxes, classify the broad excluded box as duplicate.",
          "Do not exclude a multiline paragraph merely because it spans multiple lines when no child boxes cover its full visible text.",
          "Return a textGroups entry whenever two or more adjacent OCR boxes are separate visual lines of one wrapped sentence or paragraph.",
          "Each textGroups entry must list the member regionIds in reading order and provide the complete corrected mergedText.",
          "Do not group a heading with body copy, separate list items, neighboring buttons, form fields, table cells, or text from different columns.",
          "You may only choose a translationItemId listed in that region's candidates.",
          "Never invent a key or candidate ID.",
          "Always correct OCR mistakes in correctedText by reading the screenshot, even when the region has no candidates.",
          "The screenshot pixels are the only source of truth for correctedText. Never rewrite visible text to resemble an available candidate.",
          "Candidate availability restricts translationItemId selection only; it must not prevent correcting visible UI text.",
          "For short button labels, inspect neighboring controls and button context carefully. For example, a button paired with No may read Yes even when OCR is badly corrupted.",
          "A short centered divider between horizontal rules commonly reads OR. OCR fragments such as O, 0R, or c 00 in that visual context must not be interpreted as a currency amount unless an amount and currency symbol are visibly present.",
          "Use the screenshot context, screen name/group, neighboring text, candidate translations, match type, and existing linkedCount.",
          "Correct clear OCR mistakes in correctedText.",
          "Use decision=link only when the selected candidate is highly reliable.",
          "Use decision=review when a candidate is plausible but duplicates or context make it uncertain.",
          "Use decision=none when no candidate is sufficiently supported.",
          "When keepRegion=false, translationItemId must be null and decision must be none.",
          "Return exactly one suggestion for every supplied region.",
          "Confidence must reflect the likelihood that the exact internal key is correct, not only that the visible translation is similar.",
          JSON.stringify(promptData),
        ].join("\n"),
      },
    ];

    if (body.imageDataUrl) {
      content.push({
        type: "input_image",
        image_url: body.imageDataUrl,
        detail: "high",
      });
    }

    const openAiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        store: false,
        reasoning: { effort: "low" },
        input: [
          {
            role: "system",
            content:
              "You are a conservative multilingual UI localization reviewer. Prefer leaving a region for review over guessing an internal translation key.",
          },
          {
            role: "user",
            content,
          },
        ],
        max_output_tokens: Math.min(12_000, 600 + regions.length * 220),
        text: {
          format: {
            type: "json_schema",
            name: "translation_key_suggestions",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                suggestions: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      regionId: { type: "string" },
                      correctedText: { type: "string" },
                      keepRegion: { type: "boolean" },
                      regionType: {
                        type: "string",
                        enum: [
                          "ui_text",
                          "logo",
                          "status_bar",
                          "illustration_noise",
                          "icon",
                          "duplicate",
                          "uncertain",
                        ],
                      },
                      translationItemId: { type: ["string", "null"] },
                      confidence: { type: "number", minimum: 0, maximum: 1 },
                      decision: { type: "string", enum: ["link", "review", "none"] },
                      reason: { type: "string" },
                    },
                    required: [
                      "regionId",
                      "correctedText",
                      "keepRegion",
                      "regionType",
                      "translationItemId",
                      "confidence",
                      "decision",
                      "reason",
                    ],
                  },
                },
                textGroups: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      groupId: { type: "string" },
                      regionIds: {
                        type: "array",
                        items: { type: "string" },
                        minItems: 2,
                        maxItems: 6,
                      },
                      mergedText: { type: "string" },
                      reason: { type: "string" },
                    },
                    required: ["groupId", "regionIds", "mergedText", "reason"],
                  },
                },
              },
              required: ["suggestions", "textGroups"],
            },
          },
        },
      }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]),
    });

    const responseBody = (await openAiResponse.json()) as OpenAiResponse;
    if (!openAiResponse.ok) {
      console.error("[ai-key-suggestions] OpenAI request failed.", {
        status: openAiResponse.status,
        message: responseBody.error?.message,
      });
      return NextResponse.json(
        { error: "OpenAI 후보 판정 요청에 실패했습니다." },
        { status: 502 },
      );
    }

    const outputText = getOutputText(responseBody);
    if (!outputText) {
      return NextResponse.json({ error: "OpenAI 응답에서 후보 결과를 찾지 못했습니다." }, { status: 502 });
    }

    const parsed = JSON.parse(outputText) as {
      suggestions?: Array<{
        regionId?: string;
        correctedText?: string;
        keepRegion?: boolean;
        regionType?:
          | "ui_text"
          | "logo"
          | "status_bar"
          | "illustration_noise"
          | "icon"
          | "duplicate"
          | "uncertain";
        translationItemId?: string | null;
        confidence?: number;
        decision?: "link" | "review" | "none";
        reason?: string;
      }>;
      textGroups?: Array<{
        groupId?: string;
        regionIds?: string[];
        mergedText?: string;
        reason?: string;
      }>;
    };

    const suggestions = (parsed.suggestions ?? [])
      .filter((suggestion) => regions.some((region) => region.id === suggestion.regionId))
      .map((suggestion) => {
        const regionId = suggestion.regionId as string;
        const candidateIds = allowedCandidateIds.get(regionId);
        const regionType = suggestion.regionType ?? "uncertain";
        const keepRegion = suggestion.keepRegion === true && regionType === "ui_text";
        const translationItemId =
          keepRegion && suggestion.translationItemId && candidateIds?.has(suggestion.translationItemId)
            ? suggestion.translationItemId
            : null;

        return {
          regionId,
          correctedText: String(suggestion.correctedText ?? "").slice(0, 500),
          keepRegion,
          regionType,
          translationItemId,
          confidence: Math.min(1, Math.max(0, Number(suggestion.confidence) || 0)),
          decision: translationItemId ? suggestion.decision ?? "review" : "none",
          reason: String(suggestion.reason ?? "").slice(0, 240),
        };
      });

    const validRegionIds = new Set(regions.map((region) => region.id));
    const textGroups = (parsed.textGroups ?? [])
      .map((group) => {
        const regionIds = Array.from(
          new Set(
            (group.regionIds ?? []).filter((regionId) => validRegionIds.has(regionId)),
          ),
        ).slice(0, 6);
        const groupId = String(group.groupId ?? "").trim().slice(0, 80);
        const mergedText = String(group.mergedText ?? "").trim().slice(0, 500);

        return {
          groupId,
          regionIds,
          mergedText,
          reason: String(group.reason ?? "").trim().slice(0, 240),
        };
      })
      .filter(
        (group) =>
          group.groupId &&
          group.regionIds.length >= 2 &&
          group.mergedText,
      );

    return NextResponse.json({
      model: MODEL,
      suggestions,
      textGroups,
      usage: {
        inputTokens: responseBody.usage?.input_tokens ?? 0,
        outputTokens: responseBody.usage?.output_tokens ?? 0,
        totalTokens: responseBody.usage?.total_tokens ?? 0,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI 후보 판정 중 오류가 발생했습니다.";
    console.error("[ai-key-suggestions] Failed.", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
