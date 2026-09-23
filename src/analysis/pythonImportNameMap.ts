/**
 * PyPI package names frequently differ from the name you actually
 * `import` in Python code - unlike npm, where the package name IS the
 * import specifier. Common examples: `Pillow` is imported as `PIL`,
 * `beautifulsoup4` as `bs4`, `PyYAML` as `yaml`, `opencv-python` as `cv2`.
 * Getting this wrong means usage detection silently finds nothing for
 * some of the most commonly-upgraded Python packages.
 *
 * This is the same "curated exceptions + honest fallback" pattern as
 * `KnownChangesProvider`: a small table for well-known mismatches, plus a
 * normalization heuristic (lowercase, hyphens/dots to underscores) that
 * correctly handles the majority of "ordinary" packages that don't need
 * an exception at all.
 */
const KNOWN_IMPORT_NAMES: Record<string, string[]> = {
  pillow: ["PIL"],
  beautifulsoup4: ["bs4"],
  pyyaml: ["yaml"],
  "python-dateutil": ["dateutil"],
  "scikit-learn": ["sklearn"],
  "opencv-python": ["cv2"],
  "opencv-python-headless": ["cv2"],
  protobuf: ["google.protobuf"],
  "google-cloud-storage": ["google.cloud.storage"],
  "google-cloud-bigquery": ["google.cloud.bigquery"],
  "flask-sqlalchemy": ["flask_sqlalchemy"],
  "flask-cors": ["flask_cors"],
  "django-rest-framework": ["rest_framework"],
  djangorestframework: ["rest_framework"],
  "python-jose": ["jose"],
  "python-jwt": ["jwt"],
  pyjwt: ["jwt"],
  "msgpack-python": ["msgpack"],
  attrs: ["attr", "attrs"],
  "typing-extensions": ["typing_extensions"],
  "python-multipart": ["multipart"],
  "websocket-client": ["websocket"],
  grpcio: ["grpc"],
};

/** Normalizes a PyPI package name into its most likely bare import-module form (lowercase, separators to underscores). */
function normalize(packageName: string): string {
  return packageName.toLowerCase().replace(/[-.]/g, "_");
}

/**
 * Returns every plausible Python import name for a PyPI package name:
 * curated exceptions (if any) plus the normalized fallback, since a
 * package can sometimes be imported under more than one name (rare, but
 * `attrs` is a real example - both `attr` and `attrs` work).
 */
export function candidateImportNames(packageName: string): string[] {
  const key = packageName.toLowerCase();
  const known = KNOWN_IMPORT_NAMES[key];
  const fallback = normalize(packageName);
  const candidates = new Set(known ?? []);
  candidates.add(fallback);
  return Array.from(candidates);
}
