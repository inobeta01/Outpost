flowchart TB
  subgraph Vendors["Vendor sources"]
    V1["OpenAPI / GraphQL specs"]
    V2["npm / PyPI registries"]
    V3["GitHub releases"]
  end

  subgraph CI["CI - GitHub Actions"]
    ADAPT["Community adapter sandbox\nisolated, no network egress beyond declared source"]
    TEST["Test suite + schema checks"]
  end

  subgraph IngestSvc["Ingestion service - container"]
    ING["Structured source adapters"]
  end

  subgraph ProcSvc["Processing service - container"]
    HASH["Content hash filter"]
    DIFF["Symbolic diff engine"]
    SCORE["Confidence scoring"]
  end

  subgraph RegistryCore["Registry core - trust root"]
    WRITER["Single-writer service\nholds signing key"]
    DB[("Postgres\nappend-only, versioned")]
    REPLICA[("Read replicas\npublic availability")]
  end

  subgraph InterfaceSvc["Interface layer"]
    MCP["MCP server\npull: get_entry, list_changes, verify_entry"]
    HOOK["Webhook service\npush: signed, pointer-only events"]
  end

  subgraph OrgInfra["Consumer org infra - self-hosted"]
    SDK["verification-sdk\npublic key verify"]
    AGENT["Agent orchestration\nClaude Code / Devin / internal"]
    SCAN["Call-site index\nAST scan of org repo"]
    FIX["Fix generator\ncodemod / bounded LLM"]
    PR["PR opened\nlinked to signed entry"]
  end

  subgraph Ops["Deployment infra"]
    SECRETS["Secrets manager\nsigning key, DB creds"]
    MON["Monitoring / logging"]
  end

  V1 --> ING
  V2 --> ING
  V3 --> ING
  ADAPT --> ING
  TEST --> ADAPT

  ING --> HASH --> DIFF --> SCORE --> WRITER
  WRITER --> DB
  DB --> REPLICA
  DB --> MCP
  DB --> HOOK

  SECRETS -.-> WRITER
  SECRETS -.-> HOOK
  MON -.-> IngestSvc
  MON -.-> ProcSvc
  MON -.-> RegistryCore

  MCP --> AGENT
  HOOK --> AGENT
  AGENT --> SDK
  SDK -.verify.-> REPLICA
  AGENT --> SCAN --> AGENT
  AGENT --> FIX --> PR