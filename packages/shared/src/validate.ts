/**
 * @outpost/source-spec — validator
 *
 * Wraps Ajv (with ajv-formats for `uri`/`date-time`) to validate
 * untrusted source-config input against `source-spec.schema.json`.
 * Used by:
 *
 *   - PR-time check (a script over `sources/*.json`)
 *   - The ingestion host loop (P1) before queuing a source
 *
 * On failure, throws SourceSpecValidationError carrying a flat list
 * of path-aware error messages — easier to read than Ajv's nested
 * `instancePath` output and friendlier in CI logs.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";

import type { SourceSpec } from "./schema.js";

const __dirname = dirname(
  fileURLToPath((import.meta as ImportMeta & { url: string }).url),
);
const SCHEMA_PATH = join(__dirname, "schemas", "source-spec.schema.json");

let cachedValidator: ValidateFn | null = null;

type ValidateFn = ReturnType<typeof buildValidator>;

function buildValidator(schema: object) {
  const ajv = new Ajv({
    allErrors: true,
    strict: true,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  // The schema is validated on import; if it doesn't compile we want to
  // know at module-load time, not on the first source-spec.
  return ajv.compile<SourceSpec>(schema);
}

async function loadValidator(): Promise<ValidateFn> {
  if (cachedValidator) return cachedValidator;
  const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf8")) as object;
  cachedValidator = buildValidator(schema);
  return cachedValidator;
}

/** Thrown when a source spec fails validation. */
export class SourceSpecValidationError extends Error {
  public readonly issues: ReadonlyArray<string>;

  constructor(issues: ReadonlyArray<string>) {
    super(`source spec validation failed:\n  - ${issues.join("\n  - ")}`);
    this.name = "SourceSpecValidationError";
    this.issues = issues;
  }
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors) return ["unknown validation error"];
  return errors.map((e) => {
    const path = e.instancePath || "<root>";
    return `${path} ${e.message ?? "invalid"}`;
  });
}

/**
 * Validate a parsed source spec object. Returns the same value narrowed
 * to `SourceSpec` on success; throws `SourceSpecValidationError` on failure.
 *
 * The `unknown` input type is the point — never trust raw JSON from disk
 * or from a community PR until this has run.
 */
export async function validateSourceSpec(input: unknown): Promise<SourceSpec> {
  const validate = await loadValidator();
  if (validate(input)) {
    return input as SourceSpec;
  }
  throw new SourceSpecValidationError(formatErrors(validate.errors));
}
