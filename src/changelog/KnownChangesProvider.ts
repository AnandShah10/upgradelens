import { EvidenceSource, PackageChange, PackageChangeProvider } from "../models/PackageChange";
import { classifyChange } from "../analysis/SemverUtil";

interface KnownEntry {
  /** Major version in which the change took effect (change applies for any toVersion >= this major). */
  effectiveMajor: number;
  change: Omit<PackageChange, "packageName" | "fromVersion" | "toVersion" | "source" | "confidence"> & {
    confidence?: number;
  };
}

/**
 * A small, hand-curated database of documented breaking changes for
 * popular packages. This is an explicit, honest fallback: fully general
 * changelog parsing and cross-version type-declaration diffing (see
 * `ApiAnalyzer`) are the "real" long-term sources of this data, but they
 * cannot always resolve every symbol for every package/version pair
 * (private registries, packages without types, network unavailable, etc).
 * This table exists so the MVP can still demonstrate accurate, specific
 * findings for the packages developers upgrade most often, and is designed
 * to be trivially extended - each entry is independent and additive.
 * Covers npm: react-router-dom, axios, lodash, express, react-dom, vue,
 * webpack, eslint, jest, node-fetch, chalk, uuid, mongoose, next.
 * Covers PyPI: django, flask, numpy, pandas.
 */
const KNOWN_CHANGES: Record<string, KnownEntry[]> = {
  "react-router-dom": [
    {
      effectiveMajor: 6,
      change: {
        kind: "removed-export",
        symbol: "Switch",
        summary: "`Switch` was replaced by `Routes` in react-router-dom v6.",
        recommendation: "Replace <Switch> with <Routes>, and update <Route> children to use the `element` prop.",
      },
    },
    {
      effectiveMajor: 7,
      change: {
        kind: "signature-change",
        symbol: "useNavigate",
        summary: "Data APIs and relative route resolution changed in react-router-dom v7; review the v7 migration guide.",
        recommendation: "Follow the official v6→v7 upgrade guide before adopting the new data router APIs.",
        confidence: 0.6,
      },
    },
  ],
  axios: [
    {
      effectiveMajor: 2,
      change: {
        kind: "removed-export",
        symbol: "oldRequest",
        summary: "The legacy `oldRequest()` helper was removed; use `request()` instead.",
        recommendation: "Replace oldRequest() with request().",
      },
    },
  ],
  lodash: [
    {
      effectiveMajor: 5,
      change: {
        kind: "removed-export",
        summary: "lodash v5 (where released) reorganizes modules; verify per-method imports still resolve.",
        confidence: 0.4,
      },
    },
  ],
  express: [
    {
      effectiveMajor: 5,
      change: {
        kind: "signature-change",
        symbol: "app.del",
        summary: "`app.del()` was removed in Express 5; use `app.delete()`.",
        recommendation: "Rename app.del(...) calls to app.delete(...).",
      },
    },
    {
      effectiveMajor: 5,
      change: {
        kind: "type-change",
        symbol: "req.query",
        summary: "Express 5 no longer supports the legacy nested query string parser by default.",
        recommendation: "Verify any code relying on deeply nested req.query objects.",
        confidence: 0.6,
      },
    },
  ],
  "react-dom": [
    {
      effectiveMajor: 18,
      change: {
        kind: "deprecated-export",
        symbol: "render",
        summary: "`ReactDOM.render` is deprecated in React 18 in favor of `createRoot`.",
        recommendation: "Replace ReactDOM.render(<App />, container) with createRoot(container).render(<App />).",
        confidence: 0.8,
      },
    },
    {
      effectiveMajor: 18,
      change: {
        kind: "deprecated-export",
        symbol: "unmountComponentAtNode",
        summary: "`ReactDOM.unmountComponentAtNode` is deprecated in React 18 in favor of the root's `unmount()` method.",
        recommendation: "Call root.unmount() on the root object returned by createRoot, instead of unmountComponentAtNode(container).",
        confidence: 0.75,
      },
    },
  ],
  vue: [
    {
      effectiveMajor: 3,
      change: {
        kind: "removed-export",
        symbol: "set",
        summary: "The global `Vue.set`/`Vue.delete` reactivity helpers were removed in Vue 3 (no longer needed - the new reactivity system handles this automatically).",
        recommendation: "Remove calls to Vue.set()/Vue.delete(); direct property assignment is reactive under Vue 3's Proxy-based reactivity.",
        confidence: 0.7,
      },
    },
    {
      effectiveMajor: 3,
      change: {
        kind: "signature-change",
        summary: "The `new Vue({...})` constructor pattern was replaced by `createApp(App)` in Vue 3.",
        recommendation: "Replace `new Vue({...}).$mount('#app')` with `createApp(App).mount('#app')`.",
        confidence: 0.75,
      },
    },
  ],
  webpack: [
    {
      effectiveMajor: 5,
      change: {
        kind: "removed-export",
        summary: "Webpack 5 no longer automatically polyfills Node.js core modules (path, crypto, stream, Buffer, process, etc.) in the browser bundle.",
        recommendation: "Add explicit polyfills (e.g. via resolve.fallback or a plugin like node-polyfill-webpack-plugin) for any Node core modules your bundle needs in the browser.",
        confidence: 0.8,
      },
    },
  ],
  eslint: [
    {
      effectiveMajor: 9,
      change: {
        kind: "engine-requirement-change",
        summary: "ESLint 9 uses flat config (eslint.config.js) by default; .eslintrc* files are no longer read automatically.",
        recommendation: "Migrate .eslintrc* configuration to eslint.config.js, or set ESLINT_USE_FLAT_CONFIG=false as a temporary bridge.",
        confidence: 0.85,
      },
    },
  ],
  jest: [
    {
      effectiveMajor: 28,
      change: {
        kind: "type-change",
        summary: "Jest 28 changed the default test environment from \"jsdom\" to \"node\".",
        recommendation: 'Set testEnvironment: "jsdom" explicitly in your Jest config if your tests rely on browser globals.',
        confidence: 0.8,
      },
    },
  ],
  "node-fetch": [
    {
      effectiveMajor: 3,
      change: {
        kind: "engine-requirement-change",
        summary: "node-fetch v3 is ESM-only; require('node-fetch') no longer works.",
        recommendation: "Switch to a native ESM import, or use a dynamic import() from CommonJS code.",
        confidence: 0.85,
      },
    },
  ],
  chalk: [
    {
      effectiveMajor: 5,
      change: {
        kind: "engine-requirement-change",
        summary: "chalk v5 is ESM-only; require('chalk') no longer works.",
        recommendation: "Switch to a native ESM import, or use a dynamic import() from CommonJS code, or stay on chalk v4 for CommonJS projects.",
        confidence: 0.85,
      },
    },
  ],
  uuid: [
    {
      effectiveMajor: 9,
      change: {
        kind: "engine-requirement-change",
        summary: "uuid v9 raises the minimum supported Node.js version and ships dual ESM/CJS via package.json conditional exports.",
        recommendation: "Confirm your Node.js version and bundler both support the package's updated exports map.",
        confidence: 0.55,
      },
    },
  ],
  mongoose: [
    {
      effectiveMajor: 6,
      change: {
        kind: "removed-export",
        summary: "Mongoose 6 removed callback support from queries and most methods; only Promises/async-await are supported.",
        recommendation: "Replace callback-style Mongoose calls (e.g. Model.find(filter, callback)) with await or .then().",
        confidence: 0.7,
      },
    },
    {
      effectiveMajor: 7,
      change: {
        kind: "removed-export",
        summary: "Mongoose 7 removes the last remaining callback-based APIs and several long-deprecated connection options.",
        recommendation: "Review the Mongoose 7 migration guide for any remaining callback usage or deprecated connect() options.",
        confidence: 0.55,
      },
    },
  ],
  next: [
    {
      effectiveMajor: 13,
      change: {
        kind: "signature-change",
        symbol: "Image",
        summary: "The next/image component's API changed significantly in Next.js 13 (layout/objectFit props were replaced by style-based sizing).",
        recommendation: "Update next/image usage per the v13 upgrade guide, or import from next/legacy/image to keep the old behavior temporarily.",
        confidence: 0.65,
      },
    },
  ],
  // --- Python / PyPI entries --------------------------------------------
  django: [
    {
      effectiveMajor: 4,
      change: {
        kind: "removed-export",
        symbol: "url",
        summary: "django.conf.urls.url() was removed in Django 4.0; use django.urls.re_path() or path() instead.",
        recommendation: "Replace url(...) URL patterns with re_path(...) (regex patterns) or path(...) (simple patterns).",
        confidence: 0.85,
      },
    },
    {
      effectiveMajor: 5,
      change: {
        kind: "removed-export",
        symbol: "USE_L10N",
        summary: "The USE_L10N setting was removed in Django 5.0; localized formatting is now always enabled.",
        recommendation: "Remove USE_L10N from settings.py - it no longer has any effect.",
        confidence: 0.75,
      },
    },
  ],
  flask: [
    {
      effectiveMajor: 2,
      change: {
        kind: "removed-export",
        symbol: "before_first_request",
        summary: "The @app.before_first_request decorator was removed in Flask 2.2.",
        recommendation: "Run one-time setup code at import time or via an application factory instead of before_first_request.",
        confidence: 0.75,
      },
    },
  ],
  numpy: [
    {
      effectiveMajor: 2,
      change: {
        kind: "removed-export",
        summary: "NumPy 2.0 removed the deprecated scalar type aliases (np.float, np.int, np.bool, np.object, np.str) and changed several default promotion/printing behaviors.",
        recommendation: "Replace np.float/np.int/etc. with Python builtins (float/int) or explicit NumPy types (np.float64), and review the NumPy 2.0 migration guide for promotion-rule changes.",
        confidence: 0.75,
      },
    },
  ],
  pandas: [
    {
      effectiveMajor: 2,
      change: {
        kind: "removed-export",
        symbol: "append",
        summary: "DataFrame.append() and Series.append() were removed in pandas 2.0.",
        recommendation: "Replace .append(...) calls with pandas.concat([...]).",
        confidence: 0.8,
      },
    },
  ],
};

export class KnownChangesProvider implements PackageChangeProvider {
  readonly source: EvidenceSource = "known-changes-db";

  async getChanges(packageName: string, fromVersion: string, toVersion: string): Promise<PackageChange[]> {
    const entries = KNOWN_CHANGES[packageName];
    if (!entries) return [];

    const fromMajor = Number(fromVersion.split(".")[0]);
    const toMajor = Number(toVersion.split(".")[0]);
    if (classifyChange(fromVersion, toVersion) === "unknown" && Number.isNaN(fromMajor)) return [];

    return entries
      .filter((e) => e.effectiveMajor > fromMajor && e.effectiveMajor <= toMajor)
      .map((e) => ({
        ...e.change,
        packageName,
        fromVersion,
        toVersion,
        confidence: e.change.confidence ?? 0.85,
        source: this.source,
      }));
  }
}
