const configuredFlag = process.env.NEXT_PUBLIC_AI_AUTO_RECOGNITION_ENABLED;

export const AI_AUTO_RECOGNITION_ENABLED =
  configuredFlag === "true" ||
  (configuredFlag === undefined &&
    process.env.NEXT_PUBLIC_APP_SNAPSHOT_ID === "local-dev");
