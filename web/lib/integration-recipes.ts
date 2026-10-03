export type IntegrationRecipe = {
  id: string;
  name: string;
  description: string;
  steps: string[];
  documentation: string;
};
export const INTEGRATION_RECIPES: IntegrationRecipe[] = [
  {
    id: "github",
    name: "GitHub Actions",
    description:
      "Test the automation before a client release. Fail the workflow when its quality gate fails.",
    steps: [
      "Create a token with read, diagnostic execution and assessment access. Add live execution only when needed.",
      "Save it as the repository secret SOLARIS_API_TOKEN and save your origin as SOLARIS_URL.",
      "Use the supplied workflow and Node runner. The runner retains the job ID, polls evidence and returns the actual gate verdict.",
    ],
    documentation:
      "https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets",
  },
  {
    id: "n8n",
    name: "n8n",
    description:
      "Trigger a check from a client delivery workflow and route the saved result to your next step.",
    steps: [
      "In HTTP Request, choose Generic Credential Type → Header Auth. Set Authorization to Bearer followed by your Solaris token.",
      "POST the example JSON to /api/automation/v1/jobs. Set Content-Type: application/json and a stable Idempotency-Key for the logical delivery.",
      "Save the returned job ID. Poll GET /api/automation/v1/jobs/{id} until terminal, then fetch the run or POST its gate. Do not blindly retry failed evaluations.",
    ],
    documentation:
      "https://docs.n8n.io/integrations/builtin/credentials/httprequest/",
  },
  {
    id: "zapier",
    name: "Zapier",
    description:
      "Add a verification step to client onboarding, delivery approvals or an existing Zap.",
    steps: [
      "Use API by Zapier with an API-key connection sent in the Authorization header. The value is Bearer followed by your token.",
      "POST the example JSON to /api/automation/v1/jobs with Content-Type: application/json and an Idempotency-Key derived from the delivery event.",
      "Persist the returned ID, then poll its job endpoint in a later workflow step. A successful launch request is not a passing evaluation; inspect the gate response.",
    ],
    documentation:
      "https://help.zapier.com/hc/en-us/articles/44391650357005-Send-API-requests-in-Zap-workflows",
  },
];
export const AUTOMATION_SAMPLE = {
  mode: "dry-run",
  setup: {
    tasks: ["T01", "T02"],
    trials: 1,
    concurrency: 1,
    maxInfraFailures: 1,
    provider: "claude",
    modelId: "",
  },
};
export const AUTOMATION_ENDPOINTS = [
  ["GET", "/api/automation/v1/runs", "List saved runs", "read"],
  [
    "GET",
    "/api/automation/v1/jobs?limit=50",
    "Page through job history",
    "read",
  ],
  [
    "GET",
    "/api/automation/v1/jobs?view=reserved",
    "Read tracked executions",
    "read",
  ],
  [
    "POST",
    "/api/automation/v1/jobs",
    "Launch once with Idempotency-Key",
    "execute; live:execute for live runs",
  ],
  ["GET", "/api/automation/v1/jobs/{id}", "Read job status", "read"],
  ["GET", "/api/automation/v1/runs/{id}", "Read run evidence summary", "read"],
  [
    "POST",
    "/api/automation/v1/runs/{id}/gate",
    "Apply a quality policy",
    "assess",
  ],
  [
    "GET",
    "/api/automation/v1/compare?candidate=…&baseline=…",
    "Compare independent runs",
    "assess",
  ],
] as const;
