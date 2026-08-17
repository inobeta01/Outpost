flowchart TB
  subgraph VendorSources["Vendor sources"]
    V1["Structured\nOpenAPI, GraphQL, npm, PyPI, GH releases"]
    V2["Unstructured\nChangelogs, docs, blogs, forums"]
  end

  subgraph Ingestion["Ingestion layer (open source)"]
    I1["Structured adapters\nper-vendor, community contributed"]
    I2["Firecrawl fetch + extract"]
    I3["Adapter sandbox\nCI isolation, no network beyond declared source"]
    I4["Vendor allowlist registry"]
  end

  subgraph Processing["Processing layer (open source)"]
    P1["Content hash filter"]
    P2["Spec/SDK symbolic diff\nno LLM"]
    P3["Prose normalize\nlow-trust ChangeEvent"]
    P4["Confidence scorer"]
    P5["ChangeEvent schema validation"]
  end

  subgraph RegistryCore["Registry core (open source, trust root)"]
    R1["Single-writer service\nonly holder of write creds"]
    R2["Append-only signed DB\nPostgres"]
    R3["Signing service\nHMAC / asymmetric key"]
    R4["Public read replicas"]
    R5["Audit + diff log"]
  end

  subgraph InterfaceLayer["Agent interface layer (open source)"]
    N1["MCP server\nget_entry, list_changes, verify_entry"]
    N2["Webhook dispatcher\nsigned, pointer-only events"]
    N3["Replay guard\nnonce + timestamp store"]
    N4["Verification SDK\npublished separately"]
  end

  subgraph HostedOps["Hosted/managed layer (monetized, optional)"]
    O1["Managed crawling infra"]
    O2["Org dashboards"]
    O3["Vendor coverage SLAs"]
    O4["Subscription + billing"]
  end

  subgraph ConsumerOrg["Org's agentic infra (external, self-hosted)"]
    C1["Agent orchestration\nClaude Code, Devin, internal"]
    C2["Local call-site index\nAST scan"]
    C3["Fix generator\ncodemod-first, bounded LLM fallback"]
    C4["PR writer"]
    C5["Human review + merge"]
  end

  subgraph Observability["Observability + security (open source)"]
    S1["Structured logging"]
    S2["Anomaly detection\ndiff size, scope drift"]
    S3["Key rotation service"]
    S4["Threat model docs + SECURITY.md"]
  end

  subgraph Infra["Infra / deployment"]
    D1["Docker Compose\nlocal dev"]
    D2["CI/CD\nGitHub Actions"]
    D3["Container hosting\nFly.io / Railway / self-host"]
    D4["Secrets manager"]
    D5["IaC\nTerraform, later stage"]
  end

  V1 --> I1
  V2 --> I2
  I1 --> I3
  I2 --> I3
  I3 --> I4
  I4 --> P1

  P1 --> P2
  P1 --> P3
  P2 --> P5
  P3 --> P5
  P5 --> P4
  P4 --> R1

  R1 --> R3
  R3 --> R2
  R2 --> R4
  R2 --> R5
  R2 --> N1
  R2 --> N2

  N2 --> N3
  N1 --> N4
  N2 --> N4

  N1 --> C1
  N2 --> C1
  C1 --> C2
  C2 --> C1
  C1 --> C3
  C3 --> C4
  C4 --> C5

  R4 --> O1
  R2 --> O2
  I4 --> O3
  O2 --> O4

  R1 -.-> S1
  N2 -.-> S1
  C4 -.-> S2
  R3 -.-> S3
  S4 -.-> R1
  S4 -.-> N2

  D1 -.-> Ingestion
  D1 -.-> Processing
  D1 -.-> RegistryCore
  D2 -.-> I3
  D2 -.-> Infra
  D3 -.-> RegistryCore
  D3 -.-> InterfaceLayer
  D4 -.-> R3
  D5 -.-> D3
