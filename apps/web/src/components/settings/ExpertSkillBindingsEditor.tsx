import { useQuery } from "@tanstack/react-query";
import type { ExpertSkillBinding, SkillDefinition } from "@synara/contracts";
import { ensureExpertClient } from "~/workbench/host/expertClient";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsSectionShell, SettingsSelectPopup } from "./SettingsPanelPrimitives";
import { useSkillPackageConnection } from "./skillPackageSettingsQueries";

export const SKILL_LIBRARY_QUERY_KEY = ["server", "skillLibrary"] as const;
export function setSkillBinding(
  bindings: ReadonlyArray<ExpertSkillBinding>,
  skillId: string,
  binding: Omit<ExpertSkillBinding, "skillId"> | null,
): ExpertSkillBinding[] {
  return [
    ...bindings
      .filter((item) => item.skillId !== skillId)
      .map((item) =>
        binding?.enabled && binding.activation === "startup" && item.activation === "startup"
          ? { ...item, activation: "on-demand" as const }
          : item,
      ),
    ...(binding ? [{ skillId, ...binding }] : []),
  ];
}

export function SkillBindingControls({
  skillId,
  bindings,
  disabled,
  onChange,
}: {
  skillId: string;
  bindings: ReadonlyArray<ExpertSkillBinding>;
  disabled?: boolean;
  onChange: (bindings: ExpertSkillBinding[]) => void;
}) {
  const binding = bindings.find((item) => item.skillId === skillId);
  if (!binding)
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() =>
          onChange(setSkillBinding(bindings, skillId, { enabled: true, activation: "on-demand" }))
        }
      >
        绑定
      </Button>
    );
  return (
    <div className="flex shrink-0 items-center gap-2">
      <Switch
        aria-label="启用绑定技能"
        checked={binding.enabled}
        disabled={disabled}
        onCheckedChange={(enabled) =>
          onChange(setSkillBinding(bindings, skillId, { ...binding, enabled }))
        }
      />
      <Select
        value={binding.activation}
        disabled={disabled}
        onValueChange={(value) => {
          if (value === "startup" || value === "on-demand")
            onChange(setSkillBinding(bindings, skillId, { ...binding, activation: value }));
        }}
      >
        <SelectTrigger size="sm" aria-label="技能加载时机" className="w-28">
          <SelectValue>{binding.activation === "startup" ? "启动时" : "按需"}</SelectValue>
        </SelectTrigger>
        <SettingsSelectPopup>
          <SelectItem value="on-demand">按需</SelectItem>
          <SelectItem value="startup">启动时</SelectItem>
        </SettingsSelectPopup>
      </Select>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => onChange(setSkillBinding(bindings, skillId, null))}
      >
        解绑
      </Button>
    </div>
  );
}

export function ExpertSkillBindingsEditor({
  bindings,
  disabled,
  onChange,
}: {
  bindings: ReadonlyArray<ExpertSkillBinding>;
  disabled: boolean;
  onChange: (bindings: ExpertSkillBinding[]) => void;
}) {
  const connection = useSkillPackageConnection();
  const query = useQuery({
    queryKey: [...SKILL_LIBRARY_QUERY_KEY, connection.generation],
    queryFn: () => ensureExpertClient().skillLibrary({ action: "list" }),
    enabled: connection.connected,
  });
  const skills = query.data?.skills ?? [];
  const byId = new Map(skills.map((skill) => [skill.skillId, skill]));
  const rows: Pick<SkillDefinition, "skillId" | "name" | "description">[] = [
    ...skills,
    ...bindings
      .filter((binding) => !byId.has(binding.skillId))
      .map((binding) => ({
        skillId: binding.skillId,
        name: binding.skillId,
        description: "技能不可用；解绑或在技能管理中检查。",
      })),
  ];
  return (
    <SettingsSectionShell
      title="技能"
      count={bindings.filter((binding) => binding.enabled).length}
      layout="compact"
    >
      <p className="pb-2 text-ui-sm text-muted-foreground">
        新任务使用已启用技能的最新保存版本；已接受任务保留固定版本。最多一个启动技能。空装配启用零个技能。
      </p>
      {query.isError ? (
        <p role="alert" className="text-ui-sm text-destructive">
          无法读取技能库。
        </p>
      ) : null}
      {!rows.length ? (
        <p className="py-2 text-ui-sm text-muted-foreground">在设置 → 技能中新建或导入技能。</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((skill) => (
            <li
              key={skill.skillId}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="text-ui font-medium">{skill.name}</p>
                <p className="text-ui-sm text-muted-foreground">{skill.description}</p>
              </div>
              <SkillBindingControls
                skillId={skill.skillId}
                bindings={bindings}
                disabled={disabled || !connection.connected}
                onChange={onChange}
              />
            </li>
          ))}
        </ul>
      )}
    </SettingsSectionShell>
  );
}
