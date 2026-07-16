import { describe, expect, test } from "bun:test";
import {
  ArgInjectionError,
  validateArg,
  validateBranchName,
  validateFilter,
  validateFreeText,
  validateId,
  validateRef,
  validateRepo,
  validateSearchQuery,
  validateSlug,
} from "../src/sanitize.ts";

// ── validateArg ────────────────────────────────────────────────────────────

describe("validateArg", () => {
  test("returns the value unchanged when valid", () => {
    expect(validateArg("my-project", "p")).toBe("my-project");
    expect(validateArg("ENG-123", "ref")).toBe("ENG-123");
    expect(validateArg("feat.branch", "b")).toBe("feat.branch");
  });

  test("rejects empty string", () => {
    expect(() => validateArg("", "p")).toThrow(ArgInjectionError);
  });

  test("rejects leading dash (flag injection)", () => {
    expect(() => validateArg("-flag", "p")).toThrow(ArgInjectionError);
    expect(() => validateArg("--help", "p")).toThrow(ArgInjectionError);
    expect(() => validateArg("-", "p")).toThrow(ArgInjectionError);
  });

  test("rejects null bytes", () => {
    expect(() => validateArg("abc\x00def", "p")).toThrow(ArgInjectionError);
  });

  test("rejects newlines", () => {
    expect(() => validateArg("abc\ndef", "p")).toThrow(ArgInjectionError);
    expect(() => validateArg("abc\rdef", "p")).toThrow(ArgInjectionError);
  });

  test("rejects shell metacharacters", () => {
    expect(() => validateArg("a;b", "p")).toThrow(ArgInjectionError);
    expect(() => validateArg("a&b", "p")).toThrow(ArgInjectionError);
    expect(() => validateArg("a|b", "p")).toThrow(ArgInjectionError);
    expect(() => validateArg("a`b", "p")).toThrow(ArgInjectionError);
    expect(() => validateArg("a$b", "p")).toThrow(ArgInjectionError);
    expect(() => validateArg("a<b", "p")).toThrow(ArgInjectionError);
    expect(() => validateArg("a>b", "p")).toThrow(ArgInjectionError);
    expect(() => validateArg("a\\b", "p")).toThrow(ArgInjectionError);
  });

  test("rejects path traversal via ..", () => {
    expect(() => validateArg("../etc/passwd", "p")).toThrow(ArgInjectionError);
    expect(() => validateArg("foo/../bar", "p")).toThrow(ArgInjectionError);
    expect(() => validateArg("a..b", "p")).toThrow(ArgInjectionError);
  });

  test("rejects absolute path prefix", () => {
    expect(() => validateArg("/etc/passwd", "p")).toThrow(ArgInjectionError);
  });
});

// ── validateFreeText ───────────────────────────────────────────────────────

describe("validateFreeText", () => {
  test("returns the value unchanged for rich content", () => {
    const msg = "fix: update $(version) handling & bump to v2.0 (stable)";
    expect(validateFreeText(msg, "message")).toBe(msg);
  });

  test("accepts values that start with a dash (they are flag values)", () => {
    expect(validateFreeText("-not-a-flag", "message")).toBe("-not-a-flag");
  });

  test("rejects empty string", () => {
    expect(() => validateFreeText("", "content")).toThrow(ArgInjectionError);
  });

  test("rejects null bytes", () => {
    expect(() => validateFreeText("abc\x00", "content")).toThrow(ArgInjectionError);
  });

  test("accepts multi-line content (argv is a spawn array, no shell)", () => {
    const msg = "Implement TAV-96.\n\nWorkflow:\n\t- checkout main\n\t- create branch";
    expect(validateFreeText(msg, "prompt")).toBe(msg);
  });
});

// ── validateSearchQuery ────────────────────────────────────────────────────

describe("validateSearchQuery", () => {
  test("accepts natural language with punctuation", () => {
    const q = "fix $DB_URL bug (backend) & deploy";
    expect(validateSearchQuery(q, "query")).toBe(q);
  });

  test("rejects empty string", () => {
    expect(() => validateSearchQuery("", "query")).toThrow(ArgInjectionError);
  });

  test("rejects leading dash (would be parsed as a flag)", () => {
    expect(() => validateSearchQuery("-filter=something", "query")).toThrow(ArgInjectionError);
  });

  test("rejects null bytes", () => {
    expect(() => validateSearchQuery("abc\x00", "query")).toThrow(ArgInjectionError);
  });
});

// ── validateSlug ───────────────────────────────────────────────────────────

describe("validateSlug", () => {
  test("accepts valid slugs", () => {
    expect(validateSlug("my-project")).toBe("my-project");
    expect(validateSlug("proj_v2")).toBe("proj_v2");
    expect(validateSlug("a")).toBe("a");
    expect(validateSlug("v1.0")).toBe("v1.0");
  });

  test("rejects leading dash", () => {
    expect(() => validateSlug("-bad")).toThrow(ArgInjectionError);
  });

  test("rejects shell metacharacters", () => {
    expect(() => validateSlug("proj;bad")).toThrow(ArgInjectionError);
  });

  test("rejects path traversal", () => {
    expect(() => validateSlug("../etc")).toThrow(ArgInjectionError);
  });

  test("rejects slugs with spaces", () => {
    expect(() => validateSlug("my project")).toThrow(ArgInjectionError);
  });

  test("rejects slugs starting with non-alphanumeric", () => {
    expect(() => validateSlug(".hidden")).toThrow(ArgInjectionError);
  });
});

// ── validateBranchName ─────────────────────────────────────────────────────

describe("validateBranchName", () => {
  test("accepts valid branch names", () => {
    expect(validateBranchName("main")).toBe("main");
    expect(validateBranchName("feat/tav-65-webhook")).toBe("feat/tav-65-webhook");
    expect(validateBranchName("fix/issue-123")).toBe("fix/issue-123");
    expect(validateBranchName("release-v1.0.0")).toBe("release-v1.0.0");
    expect(validateBranchName("sha-abc123")).toBe("sha-abc123");
  });

  test("rejects empty string", () => {
    expect(() => validateBranchName("")).toThrow(ArgInjectionError);
  });

  test("rejects leading dash (flag injection)", () => {
    expect(() => validateBranchName("-risky")).toThrow(ArgInjectionError);
    expect(() => validateBranchName("--flag")).toThrow(ArgInjectionError);
  });

  test("rejects '..' path traversal", () => {
    expect(() => validateBranchName("feat/../evil")).toThrow(ArgInjectionError);
  });

  test("rejects '@{' reflog syntax", () => {
    expect(() => validateBranchName("branch@{0}")).toThrow(ArgInjectionError);
  });

  test("rejects trailing '.'", () => {
    expect(() => validateBranchName("branch.")).toThrow(ArgInjectionError);
  });

  test("rejects trailing '/'", () => {
    expect(() => validateBranchName("feat/")).toThrow(ArgInjectionError);
  });

  test("rejects git-forbidden characters", () => {
    expect(() => validateBranchName("feat~1")).toThrow(ArgInjectionError);
    expect(() => validateBranchName("rev^2")).toThrow(ArgInjectionError);
    expect(() => validateBranchName("ref:name")).toThrow(ArgInjectionError);
    expect(() => validateBranchName("name with space")).toThrow(ArgInjectionError);
  });

  test("rejects shell metacharacters", () => {
    expect(() => validateBranchName("feat;evil")).toThrow(ArgInjectionError);
    expect(() => validateBranchName("feat$var")).toThrow(ArgInjectionError);
  });
});

// ── validateRef ────────────────────────────────────────────────────────────

describe("validateRef", () => {
  test("accepts human identifiers", () => {
    expect(validateRef("ENG-123")).toBe("ENG-123");
    expect(validateRef("TAV-9")).toBe("TAV-9");
    expect(validateRef("ABC-001")).toBe("ABC-001");
  });

  test("accepts UUIDs", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(validateRef(uuid)).toBe(uuid);
  });

  test("rejects leading dash", () => {
    expect(() => validateRef("-ENG-123")).toThrow(ArgInjectionError);
  });

  test("rejects shell metacharacters", () => {
    expect(() => validateRef("ENG;123")).toThrow(ArgInjectionError);
    expect(() => validateRef("ENG$123")).toThrow(ArgInjectionError);
  });

  test("rejects refs with forbidden characters", () => {
    expect(() => validateRef("ENG 123")).toThrow(ArgInjectionError);
    expect(() => validateRef("ENG/123")).toThrow(ArgInjectionError);
  });
});

// ── validateId ─────────────────────────────────────────────────────────────

describe("validateId", () => {
  test("accepts machine and task ids", () => {
    expect(validateId("m-123")).toBe("m-123");
    expect(validateId("t-456")).toBe("t-456");
    expect(validateId("abc123")).toBe("abc123");
  });

  test("rejects leading dash", () => {
    expect(() => validateId("-m-123")).toThrow(ArgInjectionError);
  });

  test("rejects shell metacharacters", () => {
    expect(() => validateId("m;123")).toThrow(ArgInjectionError);
  });

  test("rejects ids with dots or slashes", () => {
    expect(() => validateId("m.123")).toThrow(ArgInjectionError);
    expect(() => validateId("m/123")).toThrow(ArgInjectionError);
  });
});

// ── validateRepo ───────────────────────────────────────────────────────────

describe("validateRepo", () => {
  test("accepts valid owner/repo names", () => {
    expect(validateRepo("octocat/hello-world")).toBe("octocat/hello-world");
    expect(validateRepo("org/repo.name")).toBe("org/repo.name");
    expect(validateRepo("user_name/My_Repo")).toBe("user_name/My_Repo");
  });

  test("rejects missing slash", () => {
    expect(() => validateRepo("nodash")).toThrow(ArgInjectionError);
  });

  test("rejects leading dash", () => {
    expect(() => validateRepo("-org/repo")).toThrow(ArgInjectionError);
  });

  test("rejects multiple slashes", () => {
    expect(() => validateRepo("org/repo/extra")).toThrow(ArgInjectionError);
  });

  test("rejects shell metacharacters", () => {
    expect(() => validateRepo("org;repo/name")).toThrow(ArgInjectionError);
    expect(() => validateRepo("org/repo$evil")).toThrow(ArgInjectionError);
  });

  test("rejects path traversal", () => {
    expect(() => validateRepo("../org/repo")).toThrow(ArgInjectionError);
  });
});

// ── validateFilter ─────────────────────────────────────────────────────────

describe("validateFilter", () => {
  test("accepts valid dbxcli filter expressions", () => {
    expect(validateFilter("status=Done")).toBe("status=Done");
    expect(validateFilter("status!=Canceled")).toBe("status!=Canceled");
    expect(validateFilter("labels in bug,urgent")).toBe("labels in bug,urgent");
    expect(validateFilter("priority>2")).toBe("priority>2");
  });

  test("rejects empty string", () => {
    expect(() => validateFilter("")).toThrow(ArgInjectionError);
  });

  test("rejects leading dash", () => {
    expect(() => validateFilter("-flag=value")).toThrow(ArgInjectionError);
  });

  test("rejects shell metacharacters (but allows < and > as comparison operators)", () => {
    expect(() => validateFilter("status=Done; rm -rf /")).toThrow(ArgInjectionError);
    expect(() => validateFilter("status=Done|evil")).toThrow(ArgInjectionError);
    expect(() => validateFilter("status=$(bad)")).toThrow(ArgInjectionError);
    // '<' and '>' are allowed because the filter DSL uses them as comparison operators
    expect(validateFilter("priority>2")).toBe("priority>2");
    expect(validateFilter("priority<5")).toBe("priority<5");
  });

  test("rejects control characters", () => {
    expect(() => validateFilter("status=Done\n--flag")).toThrow(ArgInjectionError);
  });

  test("accepts every documented operator, with or without spaces", () => {
    expect(validateFilter("status~progress")).toBe("status~progress");
    expect(validateFilter("status!~progress")).toBe("status!~progress");
    expect(validateFilter("status = Backlog")).toBe("status = Backlog");
    expect(validateFilter("labels nin bug,urgent")).toBe("labels nin bug,urgent");
    expect(validateFilter("project_id=25afba6f-32b0-45c5-868b-67db252f4950")).toBe(
      "project_id=25afba6f-32b0-45c5-868b-67db252f4950",
    );
  });

  test("rejects clauses that do not match the filter grammar", () => {
    // The exact malformed shapes the agent tried in session logs (TAV backlog).
    expect(() => validateFilter("status:Backlog")).toThrow(ArgInjectionError);
    expect(() => validateFilter("status in")).toThrow(ArgInjectionError);
    expect(() => validateFilter("status_in Backlog")).toThrow(ArgInjectionError);
    expect(() => validateFilter('["status" "Backlog"]')).toThrow(ArgInjectionError);
    expect(() => validateFilter("Backlog")).toThrow(ArgInjectionError);
  });

  test("grammar rejection names the expected syntax", () => {
    expect(() => validateFilter("status:Backlog")).toThrow(/field<op>value/);
  });
});
