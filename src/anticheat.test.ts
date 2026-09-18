import { expect, test } from "bun:test";
import { checkDiff } from "./anticheat";

test("empty diff → empty", () => {
  expect(checkDiff("")).toMatchObject({ ok: false, rule: "empty" });
  expect(checkDiff("   \n")).toMatchObject({ ok: false, rule: "empty" });
});

test("added it.skip → skip-test", () => {
  const diff = `diff --git a/src/foo.test.ts b/src/foo.test.ts
--- a/src/foo.test.ts
+++ b/src/foo.test.ts
@@ -1,3 +1,3 @@
-    it("x", () => {
+    it.skip("x", () => {
`;
  expect(checkDiff(diff)).toMatchObject({ ok: false, rule: "skip-test" });
});

test(".github/workflows add continue-on-error → weaken-ci", () => {
  const diff = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1,2 +1,3 @@
 name: ci
+  continue-on-error: true
`;
  expect(checkDiff(diff)).toMatchObject({ ok: false, rule: "weaken-ci" });
});

test("remove a workflow step without continue-on-error → ok", () => {
  const diff = `diff --git a/.github/workflows/deploy.yml b/.github/workflows/deploy.yml
--- a/.github/workflows/deploy.yml
+++ b/.github/workflows/deploy.yml
@@ -10,4 +10,2 @@
     - name: Lint
       run: make lint
-    - name: Gate candidate image with live AI provider
-      run: python -m trial_tool_webapp.provider_smoke
     - name: Deploy
`;
  expect(checkDiff(diff)).toMatchObject({ ok: true });
});

test("delete src/foo.test.ts only → delete-test", () => {
  const diff = `diff --git a/src/foo.test.ts b/src/foo.test.ts
deleted file mode 100644
index abcdef0..0000000
--- a/src/foo.test.ts
+++ /dev/null
@@ -1 +0,0 @@
-test("x", () => {});
`;
  expect(checkDiff(diff)).toMatchObject({ ok: false, rule: "delete-test" });
});

test("delete src/foo.test.ts and add src/foo.spec.ts → ok", () => {
  const diff = `diff --git a/src/foo.test.ts b/src/foo.test.ts
deleted file mode 100644
index abcdef0..0000000
--- a/src/foo.test.ts
+++ /dev/null
@@ -1 +0,0 @@
-test("x", () => {});
diff --git a/src/foo.spec.ts b/src/foo.spec.ts
new file mode 100644
index 0000000..abcdef1
--- /dev/null
+++ b/src/foo.spec.ts
@@ -0,0 +1 @@
+test("x", () => {});
`;
  expect(checkDiff(diff)).toMatchObject({ ok: true });
});

test("timeout-minutes 10 to 60 only → timeout-only", () => {
  const diff = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1,3 +1,3 @@
-  timeout-minutes: 10
+  timeout-minutes: 60
`;
  expect(checkDiff(diff)).toMatchObject({ ok: false, rule: "timeout-only" });
});

test("normal src/foo.ts type fix → ok", () => {
  const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
-const x: number = "1";
+const x: number = 1;
`;
  expect(checkDiff(diff)).toMatchObject({ ok: true });
});

test("diff containing ghp_ + 36 alnum → secret", () => {
  const token = `ghp_${"a".repeat(36)}`;
  const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,1 @@
-const t = "";
+const t = "${token}";
`;
  expect(checkDiff(diff)).toMatchObject({ ok: false, rule: "secret" });
});
