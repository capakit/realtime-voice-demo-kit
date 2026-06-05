import { createWorkloadSdk } from "@capakit/sdk";
import { startVoiceHttpServer } from "./capakit_http.ts";

const sdk = createWorkloadSdk();
sdk.hijackConsoleLogging();

startVoiceHttpServer(sdk);
