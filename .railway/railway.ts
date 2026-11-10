import { defineRailway, github, project, service, volume } from "railway/iac";
// Railway IaC. Replaces railway.toml / railway.json, which Railway stops reading on 2026-12-01.
// Build, healthcheck, start command, cron and restart policy live on the service; deploys do not read this file.
// Check drift: npm install railway in a scratch parent directory (not this repo), railway link, railway config plan.
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "ai-gateway";
export default defineRailway(() => {
  const aiGatewayVolume = volume("ai-gateway-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-east4-eqdc4a", sizeMB: 5000 });
  const aiGateway = service("ai-gateway", {
    source: github("bookchaowalit/platform-ai-gateway-api", { branch: "main", checkSuites: true }),
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    healthcheck: "/healthz",
    healthcheckTimeout: 60,
    replicas: { "us-east4-eqdc4a": 1 },
    domains: ["api.bookchaowalit.com"],
    volumeMounts: { "/data": aiGatewayVolume },
  });

  return project("platform-ai-gateway-api", {
    variables: { managed: false },
    resources: [aiGateway, aiGatewayVolume],
  });
});
