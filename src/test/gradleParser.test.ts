import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGradleBuildScript, parseVersionCatalog, resolveLibsReferences } from "../package/gradleParser";

test("parses implementation string coordinates", () => {
  const src = `
dependencies {
  implementation 'com.google.guava:guava:31.1-jre'
  api("org.slf4j:slf4j-api:2.0.9")
  testImplementation 'junit:junit:4.13.2'
}
`;
  const deps = parseGradleBuildScript(src);
  assert.ok(deps.some((d) => d.name === "com.google.guava:guava" && d.declaredRange === "31.1-jre"));
  assert.ok(deps.some((d) => d.name === "org.slf4j:slf4j-api"));
  assert.ok(deps.some((d) => d.name === "junit:junit" && d.kind === "devDependencies"));
});

test("parses Kotlin DSL named arguments", () => {
  const src = `dependencies {
  implementation(group = "com.squareup.okhttp3", name = "okhttp", version = "4.12.0")
}`;
  const deps = parseGradleBuildScript(src);
  assert.ok(deps.some((d) => d.name === "com.squareup.okhttp3:okhttp" && d.declaredRange === "4.12.0"));
});

test("ignores comments", () => {
  const src = `
// implementation 'com.fake:lib:1.0'
dependencies {
  implementation 'com.real:lib:2.0'
}
`;
  const deps = parseGradleBuildScript(src);
  assert.equal(deps.length, 1);
  assert.equal(deps[0].name, "com.real:lib");
});



test("parseVersionCatalog resolves module and version.ref", () => {
  const toml = `
[versions]
guava = "31.1-jre"

[libraries]
guava = { module = "com.google.guava:guava", version.ref = "guava" }
okhttp = "com.squareup.okhttp3:okhttp:4.12.0"
`;
  const cat = parseVersionCatalog(toml);
  assert.equal(cat.get("guava")?.name, "com.google.guava:guava");
  assert.equal(cat.get("guava")?.version, "31.1-jre");
  assert.equal(cat.get("okhttp")?.version, "4.12.0");
});

test("resolveLibsReferences maps libs.xxx to coordinates", () => {
  const cat = parseVersionCatalog(`[libraries]\nguava = "com.google.guava:guava:31.1-jre"\n`);
  const deps = resolveLibsReferences(`dependencies { implementation(libs.guava) }`, cat);
  assert.ok(deps.some((d) => d.name === "com.google.guava:guava"));
});
