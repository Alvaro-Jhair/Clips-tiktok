export type UserSession = {
  url?: string;
  skipIntroMinutes?: number;
  count?: number;
  duration?: "30" | "45" | "60" | "auto";
  processing?: boolean;
  outputPaths?: {
    clips: string[];
    metadata: string;
  };
};

export type SessionState = Record<number, UserSession>;

export type PipelineResult = {
  clips: string[];
  metadataPath: string;
};
