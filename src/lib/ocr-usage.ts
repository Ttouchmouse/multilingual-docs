export const OCR_FREE_MONTHLY_LIMIT = 1_000;

export type OcrUsageSummary = {
  month: string;
  used: number;
  limit: number;
};
