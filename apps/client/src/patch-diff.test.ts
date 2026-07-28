import { describe, expect, it } from "vitest";
import { parseUnifiedPatch } from "./patch-diff";

const sample = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line1
-line2
+line2 changed
 line3
+line4
diff --git a/src/b.bin b/src/b.bin
new file mode 100644
index 000..333
Binary files /dev/null and b/src/b.bin differ
`;

describe("parseUnifiedPatch", () => {
  it("rebuilds per-file sides and marks binary", () => {
    const files = parseUnifiedPatch(sample);
    expect(files).toHaveLength(2);
    expect(files[0]?.path).toBe("src/a.ts");
    expect(files[0]?.original).toContain("line2");
    expect(files[0]?.modified).toContain("line2 changed");
    expect(files[0]?.modified).toContain("line4");
    expect(files[0]?.added).toBe(2);
    expect(files[0]?.removed).toBe(1);
    expect(files[1]?.path).toBe("src/b.bin");
    expect(files[1]?.binary).toBe(true);
  });
});
