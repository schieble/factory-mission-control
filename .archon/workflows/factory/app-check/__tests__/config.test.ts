import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyFactoryConfig, DEFAULTS, parseFactoryConfig, replaceManagedPolicy } from "../../../../scripts/factory-config.ts";

describe("factory config", () => {
  test("defaults omitted optional keys without inventing an app command", () => {
    const config = parseFactoryConfig("app_check:\n  trigger: always\n");
    expect(config.app_check.trigger).toBe("always");
    expect(config.app_check.frontend_paths).toEqual(DEFAULTS.app_check.frontend_paths);
    expect(config.app.start).toBe("");
    expect(config.app_check.enabled).toBe(false);
  });

  test("rejects malformed and unknown settings", () => {
    expect(() => parseFactoryConfig("autonomy: reckless\n")).toThrow("expected one of");
    expect(() => parseFactoryConfig("mystery: true\n")).toThrow("unknown setting");
    expect(() => parseFactoryConfig("app_check:\n  enabled: true\n")).toThrow("app.start");
    const runtime = process.platform === "win32" ? "C:/runtime/scenario.json" : "/runtime/scenario.json";
    expect(parseFactoryConfig(`app_check:\n  enabled: true\napp:\n  runtime: ${runtime}\n  teardown: bash teardown.sh\n`).app.runtime).toBe(runtime);
    expect(() => parseFactoryConfig("app:\n  runtime: relative/scenario.json\n")).toThrow("app.runtime");
    expect(() => parseFactoryConfig("models:\n  aliases:\n    manager:\n      provider: codex\n      model: x\n")).toThrow("start with @");
    expect(() => parseFactoryConfig("models:\n  aliases:\n    '@manager':\n      model: x\n")).toThrow("provider");
    expect(() => parseFactoryConfig("triggers:\n  manager:\n    capacity: 2\n")).toThrow("unknown setting");
    expect(() => parseFactoryConfig("models:\n  tiers:\n    medium: { provider: codex, model: x, effort: impossible }\n")).toThrow("expected one of");
  });


  test("applies selected providers, current trigger shape, and preserves unrelated profiles and policy prose", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-config-test-"));
    const archon = join(root, ".archon"), policy = join(archon, "sdlc", "policy");
    mkdirSync(policy, { recursive: true });
    writeFileSync(join(policy, "triage.md"), "# Team triage\n\nKeep this project-specific rule.\n");
    writeFileSync(join(archon, "config.yaml"), "assistant: pi\ndocs:\n  path: product-docs\ntiers:\n  small: { provider: pi, model: inherited-small }\naliases:\n  '@custom': { provider: another-provider, model: custom-model }\n");
    writeFileSync(join(archon, "factory.yaml"), `
project: { repo_host: github.com, repo_path: example/widgets }
autonomy: supervised
models:
  aliases:
    '@factory-manager': { provider: claude, model: manager-model, effort: persistent }
triggers:
  enabled: true
  host_id: test-host
  run_as_user_id: e58d38eaf1528395ba6abc0da3967127
  build_queue: { interval_seconds: 0 }
  merge_queue: { interval_seconds: 0 }
  discoveries: { interval_seconds: 0 }
  manager: { interval_seconds: 900 }
  app_check: { interval_seconds: 900 }
`);

    const result = applyFactoryConfig(root);
    const triage = readFileSync(join(policy, "triage.md"), "utf8");
    expect(triage).toContain("Keep this project-specific rule.");
    expect(triage).toContain("Preset: supervised");
    expect(result.triggers).toHaveLength(2);

    const config = Bun.YAML.parse(readFileSync(join(archon, "config.yaml"), "utf8")) as any;
    expect(config.assistant).toBe("pi");
    expect(config.docs.path).toBe("product-docs");
    expect(config.tiers.small).toEqual({ provider: "pi", model: "inherited-small" });
    expect(config.aliases["@custom"]).toEqual({ provider: "another-provider", model: "custom-model" });
    expect(config.aliases["@custom"].model).toBe("custom-model");
    expect(config.aliases["@factory-manager"]).toEqual({ provider: "claude", model: "manager-model", effort: "persistent" });

    const trigger = JSON.parse(readFileSync(join(archon, "triggers", "factory-manager.json"), "utf8"));
    expect(trigger.version).toBe(1);
    expect(trigger.binding.bindingRevision).toBeNull();
    expect(trigger.binding.runAsUserId).toBe("e58d38eaf1528395ba6abc0da3967127");
    expect(trigger.binding.capacity).toBe(1);
    expect(trigger.binding.launch).toMatchObject({ workflowName: "factory-manager", isolation: { kind: "default" } });
    expect(trigger.schedule).toEqual({ intervalSeconds: 900, runAtLoad: false });
    const appCheck = JSON.parse(readFileSync(join(archon, "triggers", "factory-app-check.json"), "utf8"));
    expect(appCheck.binding.capacity).toBe(1);
    expect(appCheck.sourceInstanceId).not.toBe(trigger.sourceInstanceId);
  });

  test("keeps project-specific trigger identities stable and distinct", () => {
    const create = (repo: string) => {
      const root = mkdtempSync(join(tmpdir(), "factory-identity-test-")), archon = join(root, ".archon");
      mkdirSync(archon, { recursive: true });
      writeFileSync(join(archon, "factory.yaml"), Bun.YAML.stringify({
        project: { repo_host: "github.com", repo_path: repo },
        triggers: { enabled: true, host_id: "test-host", run_as_user_id: "e58d38eaf1528395ba6abc0da3967127", manager: { interval_seconds: 900 } },
      }));
      applyFactoryConfig(root);
      const path = join(archon, "triggers", "factory-manager.json");
      const first = JSON.parse(readFileSync(path, "utf8")).sourceInstanceId;
      applyFactoryConfig(root);
      expect(JSON.parse(readFileSync(path, "utf8")).sourceInstanceId).toBe(first);
      return first;
    };
    expect(create("example/widgets")).not.toBe(create("example/widgets"));
  });

  test("work items in Linear: the queues take the Linear team, the app check and manager keep the code repository", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-work-items-test-")), archon = join(root, ".archon");
    mkdirSync(archon, { recursive: true });
    const schedules = Object.fromEntries(["build_queue", "merge_queue", "discoveries", "manager", "app_check"].map(key => [key, { interval_seconds: 600 }]));
    writeFileSync(join(archon, "factory.yaml"), Bun.YAML.stringify({
      project: { repo_host: "github.com", repo_path: "schieble/snip" },
      work_items: { host: "linear.app", path: "wrkr/SNIP" },
      triggers: { enabled: true, host_id: "test-host", run_as_user_id: "e58d38eaf1528395ba6abc0da3967127", ...schedules },
    }));
    applyFactoryConfig(root);
    const inputs = (binding: string) => JSON.parse(readFileSync(join(archon, "triggers", `${binding}.json`), "utf8")).binding.launch.inputs;
    for (const binding of ["build-queue", "merge-queue", "discoveries"]) {
      expect(inputs(binding)).toEqual({ repo_host: "linear.app", repo_path: "wrkr/SNIP" });
    }
    expect(inputs("factory-app-check")).toEqual({ repo_path: "schieble/snip" });
    expect(inputs("factory-manager")).toEqual({ repo_path: "schieble/snip" });
  });

  test("work items default to the project repository, and need both host and path", () => {
    const config = parseFactoryConfig("project: { repo_host: github.com, repo_path: example/widgets }\n");
    expect(config.work_items).toEqual({ host: "", path: "" });
    expect(() => parseFactoryConfig("work_items: { host: linear.app }\n")).toThrow("both host and path");
    expect(() => parseFactoryConfig("work_items: { host: linear.app, path: SNIP }\n")).toThrow("WORKSPACE/TEAM");
    expect(() => parseFactoryConfig("work_items: { team: SNIP }\n")).toThrow("unknown setting");
  });

  test("deployed by Vercel: the app check needs no start command, and production is named exactly", () => {
    const config = parseFactoryConfig([
      "app_check: { enabled: true }",
      "deploy: { host: vercel, production_url: https://tally.example.com, health_path: /api/health, neon_project: bold-sun-96781354 }",
      "",
    ].join("\n"));
    expect(config.deploy).toEqual({ host: "vercel", production_url: "https://tally.example.com", health_path: "/api/health", timeout_minutes: 15, neon_project: "bold-sun-96781354" });
    expect(parseFactoryConfig("project: { repo_path: example/widgets }\n").deploy.host).toBe("");
    expect(() => parseFactoryConfig("deploy: { host: netlify }\n")).toThrow("expected one of");
    expect(() => parseFactoryConfig("deploy: { host: vercel }\n")).toThrow("deploy.production_url");
    expect(() => parseFactoryConfig("deploy: { host: vercel, production_url: http://tally.example.com }\n")).toThrow("https");
    expect(() => parseFactoryConfig("deploy: { host: vercel, production_url: https://tally.example.com/app }\n")).toThrow("no path");
    expect(() => parseFactoryConfig("deploy: { host: vercel, production_url: https://tally.example.com, health_path: health }\n")).toThrow("must start with /");
    expect(() => parseFactoryConfig("deploy: { host: vercel, production_url: https://tally.example.com, timeout_minutes: 0 }\n")).toThrow(">= 1");
    expect(() => parseFactoryConfig("deploy: { region: iad1 }\n")).toThrow("unknown setting");
  });

  test("the deploy check's timer is written only for a product Vercel deploys", () => {
    const write = (deploy: Record<string, unknown> | undefined) => {
      const root = mkdtempSync(join(tmpdir(), "factory-deploy-check-test-")), archon = join(root, ".archon");
      mkdirSync(archon, { recursive: true });
      writeFileSync(join(archon, "factory.yaml"), Bun.YAML.stringify({
        project: { repo_host: "github.com", repo_path: "schieble/tally" },
        ...(deploy ? { deploy } : {}),
        triggers: { enabled: true, host_id: "test-host", run_as_user_id: "e58d38eaf1528395ba6abc0da3967127", deploy_check: { interval_seconds: 10800 } },
      }));
      applyFactoryConfig(root);
      const path = join(archon, "triggers", "factory-deploy-check.json");
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).binding : null;
    };
    const binding = write({ host: "vercel", production_url: "https://tally.example.com" });
    expect(binding.launch.workflowName).toBe("factory-deploy-check");
    expect(binding.launch.inputs).toEqual({ repo_path: "schieble/tally" });
    expect(binding.resource).toBe("factory:github.com/schieble/tally:deploy-check");
    expect(write(undefined)).toBeNull();
  });

  test("presets differ while managed replacement preserves surrounding prose", () => {
    const original = "# Team policy\n\nBefore text.\n\nAfter text.\n";
    const rendered = (["supervised", "standard", "autonomous"] as const).map(preset => replaceManagedPolicy(original, preset, "merge"));
    expect(new Set(rendered).size).toBe(3);
    for (const text of rendered) {
      expect(text).toContain("Before text.");
      expect(text).toContain("After text.");
    }
    const updated = replaceManagedPolicy(rendered[0]!, "autonomous", "merge");
    expect(updated).toContain("Before text.");
    expect(updated).toContain("After text.");
    expect(updated).toContain("Preset: autonomous");
    expect(() => replaceManagedPolicy("<!-- FACTORY AUTONOMY: START (managed by factory-setup) -->\n", "standard", "merge")).toThrow("malformed");
  });
});
