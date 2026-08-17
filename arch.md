flowchart TB
    subgraph External["External"]
        VEND["Vendor sources\nOpenAPI, PyPI, npm, GH releases"]
        CONSUMER_INFRA["Org's own infra\nself-hosted or managed"]
    end

    subgraph OSSCore["Open source core (self-hostable)"]
        direction TB

        subgraph IngestionInfra["Ingestion workers"]
            SCHED["Scheduler / cron\npolls source adapters"]
            WORKER["Adapter worker pool\nsandboxed per-vendor"]
        end

        subgraph ProcessingInfra["Processing service"]
            DIFF["Diff + normalize service"]
            SCORE["Confidence scorer"]
        end

        subgraph RegistryInfra["Registry core"]
            PG[("Postgres\nappend-only, single writer")]
            SIGN["Signing service\nholds private key"]
            REPLICA[("Read replicas\npublic, verifiable")]
        end

        subgraph InterfaceInfra["Interface services"]
            MCP["MCP server\nstateless, horizontally scalable"]
            WEBHOOK["Webhook dispatcher\nsigned, pointer-only"]
        end

        subgraph CIInfra["CI / adapter sandbox"]
            SANDBOX["Isolated adapter test env\nno network beyond declared vendor"]
        end
    end

    subgraph ManagedLayer["Managed / hosted layer (monetized, optional)"]
        MANAGED_HOST["Managed hosting\nSLA, uptime, scaling"]
        DASH["Org dashboards"]
        COVERAGE["Vendor coverage service\nkeeps adapters current"]
    end

    subgraph VerifySDK["Verification SDK (published independently)"]
        VSDK["verification-sdk\npublic key + hash verify"]
    end

    VEND -->|polled by| SCHED
    SCHED --> WORKER
    WORKER --> DIFF
    DIFF --> SCORE
    SCORE -->|signed write| SIGN
    SIGN -->|append only| PG
    PG --> REPLICA
    PG --> MCP
    PG --> WEBHOOK

    WEBHOOK -.->|signed pointer event| CONSUMER_INFRA
    MCP -->|pull verified data| CONSUMER_INFRA
    REPLICA -->|read-only fallback| CONSUMER_INFRA

    CONSUMER_INFRA -->|verifies via| VSDK
    VSDK -.->|public key| SIGN

    SANDBOX -.->|gates merge into| WORKER

    ManagedLayer -->|optionally wraps| OSSCore
    CONSUMER_INFRA -->|opens PR against| VEND

    style PG fill:#0F6E56,color:#fff
    style SIGN fill:#0F6E56,color:#fff
    style REPLICA fill:#5DCAA5,color:#042C53
    style VSDK fill:#3C3489,color:#fff
    style ManagedLayer fill:#888780,color:#fff
