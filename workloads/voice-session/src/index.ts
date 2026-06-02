import { createRunnerSdk } from "@capakit/sdk";
import { startVoiceHttpServer } from "./capakit_http.ts";

const sdk = createRunnerSdk();
sdk.hijackConsoleLogging();

startVoiceHttpServer(sdk);
