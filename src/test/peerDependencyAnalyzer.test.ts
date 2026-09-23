import assert from "node:assert/strict";
import { test } from "node:test";
import { enrichPeerDependencyChanges, projectDependencyVersionsFrom } from "../analysis/PeerDependencyAnalyzer";
import { PackageChange } from "../models/PackageChange";

function peerChange(overrides: Partial<PackageChange>): PackageChange {
  return {
    kind: "peer-dependency-change",
    packageName: "some-lib",
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    symbol: "react",
    requiredRange: "^18.0.0",
    summary: 'Peer dependency "react" requirement changed to "^18.0.0".',
    confidence: 1,
    source: "registry-metadata",
    ...overrides,
  };
}

test("drops the finding when the installed peer already satisfies the new range", () => {
  const projectDeps = projectDependencyVersionsFrom([{ name: "react", installedVersion: "18.2.0", declaredRange: "^18.0.0" }]);
  const result = enrichPeerDependencyChanges([peerChange({})], projectDeps);
  assert.equal(result.length, 0);
});

test("escalates to a high-confidence conflict when the installed peer does not satisfy the range", () => {
  const projectDeps = projectDependencyVersionsFrom([{ name: "react", installedVersion: "17.0.2", declaredRange: "^17.0.2" }]);
  const result = enrichPeerDependencyChanges([peerChange({})], projectDeps);
  assert.equal(result.length, 1);
  assert.ok(result[0].confidence >= 0.9);
  assert.match(result[0].summary, /conflict/i);
});

test("flags a peer that isn't installed at all as newly required", () => {
  const projectDeps = projectDependencyVersionsFrom([]);
  const result = enrichPeerDependencyChanges([peerChange({})], projectDeps);
  assert.equal(result.length, 1);
  assert.match(result[0].detail ?? "", /not currently listed/);
});

test("leaves non-peer-dependency changes untouched", () => {
  const other: PackageChange = {
    kind: "deprecated-export",
    packageName: "some-lib",
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    summary: "deprecated",
    confidence: 1,
    source: "registry-metadata",
  };
  const projectDeps = projectDependencyVersionsFrom([]);
  const result = enrichPeerDependencyChanges([other], projectDeps);
  assert.deepEqual(result, [other]);
});

test("leaves the finding conservative when the range can't be parsed", () => {
  const projectDeps = projectDependencyVersionsFrom([{ name: "react", installedVersion: "not-a-version", declaredRange: "not-a-version" }]);
  const result = enrichPeerDependencyChanges([peerChange({ requiredRange: "not-a-range-either" })], projectDeps);
  assert.equal(result.length, 1);
  assert.equal(result[0].confidence, 1); // unchanged from the original
});
