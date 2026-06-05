import { createWorkloadSdk } from "@capakit/sdk";
import { registerHttp } from "./capakit_http.ts";

const sdk = createWorkloadSdk();
sdk.hijackConsoleLogging();

registerHttp(sdk);

await sdk.start();
