import { createRunnerSdk } from "@capakit/sdk";
import { registerHttp } from "./capakit_http.ts";

const sdk = createRunnerSdk();
sdk.hijackConsoleLogging();

registerHttp(sdk);

await sdk.start();
