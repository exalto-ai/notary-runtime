import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = resolve(appRoot, '../..');
const openapi = JSON.parse(readFileSync(resolve(appRoot, 'src/generated/openapi.json'), 'utf8'));
const workflowDocuments = [
  'README.md',
  'docs/local-service.md',
  'docs/admin-dashboard.md',
  'docs/agent-playbook.md',
  'skills/notary/SKILL.md',
  'skills/notary/references/workflows.md',
];
const workflowContent = workflowDocuments
  .map((file) => readFileSync(resolve(runtimeRoot, file), 'utf8'))
  .join('\n');

const basicAuth = openapi.components?.securitySchemes?.basicAuth;
if (basicAuth?.type !== 'http' || basicAuth?.scheme !== 'basic') {
  throw new Error('OpenAPI must expose the optional HTTP Basic security scheme');
}

const expectedOperations = {
  '/healthz': { get: ['200'] },
  '/readyz': { get: ['200', '503'] },
  '/openapi.json': { get: ['200'] },
  '/v1/session': { post: ['204', '401', '503'], delete: ['204', '401', '503'] },
  '/v1/status': { get: ['200', '401', '503'] },
  '/v1/settings/capture': { get: ['200', '401', '503'], put: ['200', '401', '503'] },
  '/v1/notaries': { get: ['200', '401', '500', '503'] },
  '/v1/providers': { get: ['200', '401'] },
  '/v1/traces': { get: ['200', '400', '401', '503'] },
  '/v1/traces/{trace_id}': { get: ['200', '401', '404', '503'] },
  '/v1/traces/{trace_id}/notarizations': { post: ['202', '401', '404', '409', '503'] },
  '/v1/operations/{operation_id}': { get: ['200', '401', '404', '503'] },
  '/v1/traces/{trace_id}/package.llmtrace': {
    get: ['200', '401', '404', '409', '500', '503'],
  },
  '/v1/traces/{trace_id}/content': { get: ['200', '401', '404', '409', '500', '503'] },
  '/v1/traces/{trace_id}/verify': {
    post: ['200', '401', '404', '409', '422', '500', '503'],
  },
  '/v1/verify': { post: ['200', '400', '401', '500', '503'] },
  '/v1/activity': { get: ['200', '400', '401', '503'] },
  '/v1/account': {
    get: ['200', '401', '503'],
    post: ['202', '401', '409', '503'],
    delete: ['204', '401', '409', '503'],
  },
  '/v1/account/{request_id}': { get: ['200', '401', '404', '503'] },
  '/v1/traces/{trace_id}/share': {
    get: ['200', '400', '401', '402', '404', '409', '429', '503'],
    put: ['200', '202', '400', '401', '402', '404', '409', '422', '429', '500', '503'],
    delete: ['200', '400', '401', '402', '404', '409', '429', '503'],
  },
};

const actualPaths = Object.keys(openapi.paths).sort();
const expectedPaths = Object.keys(expectedOperations).sort();
if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
  throw new Error(
    `OpenAPI path set changed. Expected ${expectedPaths.join(', ')}; received ${actualPaths.join(', ')}`,
  );
}
for (const [path, methods] of Object.entries(expectedOperations)) {
  for (const [method, statuses] of Object.entries(methods)) {
    const operation = openapi.paths[path]?.[method];
    if (!operation) throw new Error(`OpenAPI is missing ${method.toUpperCase()} ${path}`);
    if (!operation.summary?.trim() || !operation.description?.trim()) {
      throw new Error(`${method.toUpperCase()} ${path} needs a summary and description`);
    }
    if (
      path.startsWith('/v1/') &&
      JSON.stringify(operation.security) !== JSON.stringify([{}, { basicAuth: [] }])
    ) {
      throw new Error(
        `${method.toUpperCase()} ${path} must describe anonymous or configured Basic authentication`,
      );
    }
    const actualStatuses = Object.keys(operation.responses).sort();
    const expectedStatuses = [...statuses].sort();
    if (JSON.stringify(actualStatuses) !== JSON.stringify(expectedStatuses)) {
      throw new Error(
        `${method.toUpperCase()} ${path} response statuses changed: ${actualStatuses.join(', ')}`,
      );
    }
    if (!workflowContent.includes(`${method.toUpperCase()} ${path}`)) {
      throw new Error(`Workflow documentation does not name ${method.toUpperCase()} ${path}`);
    }
  }
}

function parameterNames(path, method) {
  return (openapi.paths[path][method].parameters ?? []).map((parameter) => parameter.name).sort();
}
const expectedParameters = {
  'GET /v1/traces': [
    'created_before_unix_ms',
    'created_from_unix_ms',
    'cursor',
    'limit',
    'metadata_only',
    'model',
    'provider',
    'query',
    'state',
    'status',
    'streaming',
  ],
  'GET /v1/activity': [
    'after',
    'trace_id',
    'created_after_unix_ms',
    'cursor',
    'event_type',
    'limit',
    'operation_id',
    'severity',
  ],
  'GET /v1/traces/{trace_id}/share': ['trace_id'],
};
for (const [operation, expected] of Object.entries(expectedParameters)) {
  const [method, path] = operation.split(' ');
  const actual = parameterNames(path, method.toLowerCase());
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${operation} parameters changed: ${actual.join(', ')}`);
  }
}

const expectedRequiredFields = {
  TracePage: ['items'],
  TraceDetail: [
    'artifacts',
    'notarization',
    'share',
    'trace_id',
    'state',
    'status',
    'created_at_unix_ms',
    'provider',
    'operation',
    'streaming',
    'request_bytes',
    'notarization_eligible',
    'prompt_preview',
    'prompt_preview_truncated',
    'output_preview',
    'output_preview_truncated',
  ],
  ErrorBody: ['code', 'message'],
  ErrorEnvelope: ['error'],
  ActivityItem: ['event_id', 'created_at_unix_ms', 'event_type', 'severity', 'message'],
  ActivityPage: ['items'],
  NotarizationRequest: ['trace_id', 'operation', 'deduplicated'],
  NotariesResponse: ['source', 'notaries'],
  Notary: ['name', 'operator', 'endpoint', 'transport', 'key_id', 'verification_key', 'lifecycle'],
  Provider: ['id', 'name', 'host', 'client_api', 'route_prefix', 'proxy_base_url', 'ready'],
  ProvidersResponse: ['providers'],
  NotarizationAttempt: ['attempt', 'state', 'started_at_unix_ms'],
  TechnicalOperation: [
    'operation_id',
    'kind',
    'trace_id',
    'state',
    'attempt',
    'attempt_history',
    'created_at_unix_ms',
    'progress',
    'retryable',
  ],
  OperationProgressResponse: ['phase', 'updated_at_unix_ms'],
  OperationProofProgressResponse: [
    'bytes_completed',
    'bytes_total',
    'commitments_completed',
    'commitments_total',
  ],
  AccountConnectionStartedResponse: [
    'request_id',
    'user_code',
    'verification_uri_complete',
    'expires_in_seconds',
    'poll_interval_seconds',
    'state',
  ],
  TraceShare: [
    'trace_id',
    'progress',
    'visibility',
    'access_enabled',
    'password_protected',
    'updated_at_unix_ms',
  ],
  TraceContent: ['trace_id', 'manifest', 'trace'],
  TraceSummary: [
    'trace_id',
    'state',
    'status',
    'created_at_unix_ms',
    'provider',
    'operation',
    'streaming',
    'request_bytes',
    'notarization_eligible',
    'prompt_preview',
    'prompt_preview_truncated',
    'output_preview',
    'output_preview_truncated',
  ],
  VerificationResult: ['outcome', 'verified_at_unix_ms'],
};
function requiredFields(schema) {
  const value = openapi.components.schemas[schema];
  if (!value) return [];
  const direct = value.required ?? [];
  const composed = (value.allOf ?? []).flatMap((entry) => {
    if (entry.$ref) return requiredFields(entry.$ref.split('/').at(-1));
    const nested = entry.required ?? [];
    return [...nested, ...(entry.allOf ?? []).flatMap(() => [])];
  });
  return [...new Set([...direct, ...composed])];
}
for (const [schema, expected] of Object.entries(expectedRequiredFields)) {
  const actual = requiredFields(schema).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${schema} required fields changed: ${actual.join(', ')}`);
  }
}

const shareRequest = openapi.components.schemas.PutTraceShareRequest;
if (shareRequest?.properties?.password?.writeOnly !== true) {
  throw new Error('PutTraceShareRequest.password must remain write-only');
}
for (const forbidden of ['password', 'intake_url', 'upload_url', 'status_url']) {
  if (openapi.components.schemas.TraceShare?.properties?.[forbidden]) {
    throw new Error(`TraceShare must not expose ${forbidden}`);
  }
}

for (const term of [
  '202 Accepted',
  'deduplicated',
  'attempt_history',
  'notarization_eligible',
  'state',
  'status',
  'retryable',
  'progress.proof',
  'bytes_completed',
  'commitments_completed',
  'next_cursor',
  'high_water_cursor',
  'poll_interval_seconds',
  'notary_key_id',
  'trust_source',
  'password_protected',
  'access_enabled',
]) {
  if (!workflowContent.includes(term))
    throw new Error(`Workflow documentation is missing contract term: ${term}`);
}

const screenshots = [
  'overview-light.png',
  'traces-dark.png',
  'trace-verification.png',
  'providers-light.png',
  'settings-dark.png',
  'mobile-navigation.png',
  'mobile-trace-detail.png',
];
const dashboardGuide = readFileSync(resolve(runtimeRoot, 'docs/admin-dashboard.md'), 'utf8');
for (const file of screenshots) {
  const path = resolve(runtimeRoot, 'docs/images/admin-dashboard', file);
  if (!existsSync(path)) throw new Error(`Missing documentation screenshot: ${file}`);
  const image = new RegExp(
    `!\\[([^\\]]{24,})\\]\\(images/admin-dashboard/${file.replace('.', '\\.')}\\)`,
  );
  if (!image.test(dashboardGuide)) throw new Error(`Missing useful alt text for ${file}`);
}

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : extname(entry.name) === '.md' ? [path] : [];
  });
}
const markdown = [
  resolve(runtimeRoot, 'README.md'),
  resolve(runtimeRoot, 'AGENTS.md'),
  ...markdownFiles(resolve(runtimeRoot, 'docs')),
  ...markdownFiles(resolve(runtimeRoot, 'skills')),
];
const consistencySources = [
  ...markdown,
  resolve(appRoot, 'src/generated/openapi.json'),
  resolve(appRoot, 'src/generated/api.generated.d.ts'),
  resolve(runtimeRoot, 'crates/notaryd/src/lib.rs'),
];
const obsoleteCommand =
  /notaryctl(?:(?:\s+--json)|(?:\s+--(?:config|admin-password-file)\s+\S+))*\s+(captures|notarize|notarization|operation|operations|events|login|logout|whoami|publish|proxy|verify-trace|download|config|vault|list|show|verify|decode)\b/;
for (const example of [
  'notaryctl notarize trc-example --wait',
  'notaryctl --json\ncaptures list --metadata-only',
  'notaryctl --config /tmp/notary.toml operations show op-example',
]) {
  if (!obsoleteCommand.test(example)) {
    throw new Error(`Obsolete-command check does not reject: ${example}`);
  }
}
const obsoleteDaemonInvocation = /^notaryctl(?:\s+--config\s+\S+)?\s*$/m;
for (const file of consistencySources) {
  const source = readFileSync(file, 'utf8');
  if (obsoleteCommand.test(source) || obsoleteDaemonInvocation.test(source)) {
    throw new Error(
      `Documentation retains an obsolete local operational command: ${file.replace(`${runtimeRoot}/`, '')}`,
    );
  }
}

const inaccurateClaims = [
  /signed (?:production )?notary directory/i,
  /clients cache the signed notary directory/i,
  /releases include `notaryd`/i,
  /deploy the notary and check the v2 admission prelude/i,
  /download the public evidence attached/i,
  /durable human-readable result/i,
  /processes the package in memory/i,
];
for (const file of consistencySources) {
  const source = readFileSync(file, 'utf8');
  for (const claim of inaccurateClaims) {
    if (claim.test(source)) {
      throw new Error(
        `Documentation retains an inaccurate release, trust, or rollout claim: ${file.replace(`${runtimeRoot}/`, '')}`,
      );
    }
  }
}

for (const required of [
  'notaryd',
  'notaryctl status',
  'notaryctl traces list',
  'notaryctl skill install',
  '--metadata-only',
  '--json',
]) {
  if (!workflowContent.includes(required))
    throw new Error(`Workflow documentation is missing daemon/CLI guidance: ${required}`);
}

for (const file of markdown) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split('#', 1)[0];
    if (!target || target.startsWith('http://') || target.startsWith('https://')) continue;
    const linked = resolve(dirname(file), target);
    if (!existsSync(linked))
      throw new Error(`Broken link in ${file.replace(`${runtimeRoot}/`, '')}: ${match[1]}`);
  }
}

for (const file of markdown) {
  const source = readFileSync(file, 'utf8');
  if (!source.endsWith('\n') || source.endsWith('\n\n')) {
    throw new Error(`${file.replace(`${runtimeRoot}/`, '')} must end with exactly one newline`);
  }
}
process.stdout.write(
  'Local REST documentation, screenshots, methods, statuses, filters, and schemas match the generated contract.\n',
);
