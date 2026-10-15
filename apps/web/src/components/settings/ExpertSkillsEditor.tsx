import { useState } from "react";
import type { ProviderSkillDescriptor, ProviderSkillReference } from "@synara/contracts";
import { ChevronRightIcon, XIcon } from "~/lib/icons";
import { disclosureChevronClassName } from "~/lib/disclosureMotion";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { SkillPicker } from "./SkillPicker";
import { SettingsListRow, SettingsSectionShell } from "./SettingsPanelPrimitives";
import {
  expertSkillPathKey,
  removeExpertSkillReference,
  updateExpertSkillReference,
} from "./expertSkillsSettingsModel";
import type { ExpertDraftIssue } from "./expertSettingsModel";
import { skillDisplayName, skillOriginInfo } from "./skillsSettingsModel";

export function ExpertSkillsEditor({
  skills,
  issues,
  catalog,
  catalogLoading,
  catalogError,
  disabled,
  onChange,
}: {
  skills: ReadonlyArray<ProviderSkillReference>;
  issues: ReadonlyArray<ExpertDraftIssue>;
  catalog: ReadonlyArray<ProviderSkillDescriptor>;
  catalogLoading: boolean;
  catalogError: string | null;
  disabled: boolean;
  onChange: (skills: ProviderSkillReference[]) => void;
}) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  return (
    <SettingsSectionShell
      title="技能"
      count={skills.length}
      layout="compact"
      action={
        <SkillPicker
          skills={skills}
          catalog={catalog}
          catalogLoading={catalogLoading}
          catalogError={catalogError}
          disabled={disabled}
          onApply={onChange}
        />
      }
    >
      {issues
        .filter((issue) => issue.field === "skills" && issue.index === undefined)
        .map((issue) => (
          <p
            key={`${issue.code}:${issue.message}`}
            className="pb-2 text-ui-sm text-destructive"
            role="alert"
          >
            {issue.message}
          </p>
        ))}
      {skills.length > 0 ? (
        <ul className="divide-y divide-border border-t border-border" aria-label="已配置技能">
          {skills.map((skill, index) => {
            const rowIssues = issues.filter(
              (issue) => issue.field === "skills" && issue.index === index,
            );
            const open = expandedIndex === index || rowIssues.length > 0;
            const descriptor = catalog.find(
              (item) => expertSkillPathKey(item.path) === expertSkillPathKey(skill.path),
            );
            const name =
              descriptor?.name === skill.name ? skillDisplayName(descriptor) : skill.name;
            return (
              // Editable names and paths cannot serve as keys without remounting focused inputs.
              // eslint-disable-next-line react/no-array-index-key
              <li key={index}>
                <Collapsible
                  open={open}
                  onOpenChange={(next) => setExpandedIndex(next ? index : null)}
                >
                  <SettingsListRow
                    layout="compact"
                    className="px-0 py-2"
                    title={
                      <CollapsibleTrigger
                        className="flex w-full min-w-0 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={`查看技能 ${skill.name || index + 1}`}
                      >
                        <ChevronRightIcon className={disclosureChevronClassName(open)} />
                        <span className="min-w-0 truncate">{name || "未命名技能"}</span>
                        <span className="shrink-0 text-ui-xs font-normal text-muted-foreground">
                          {descriptor ? skillOriginInfo(descriptor.scope).label : "按路径"}
                        </span>
                      </CollapsibleTrigger>
                    }
                    actions={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={disabled}
                        aria-label={`移除技能 ${skill.name || index + 1}`}
                        title="移除"
                        onClick={() => {
                          setExpandedIndex(null);
                          onChange(removeExpertSkillReference(skills, index));
                        }}
                      >
                        <XIcon />
                      </Button>
                    }
                  />
                  <CollapsiblePanel>
                    <div className="grid gap-2 pb-2 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
                      {(["name", "path"] as const).map((field) => {
                        const fieldIssues = rowIssues.filter((issue) => issue.subfield === field);
                        return (
                          <label key={field} className="min-w-0 space-y-1 text-ui-sm">
                            <span className="text-muted-foreground">
                              {field === "name" ? "名称" : "技能入口路径"}
                            </span>
                            <Input
                              aria-label={`技能 ${index + 1} ${field === "name" ? "名称" : "路径"}`}
                              aria-invalid={fieldIssues.length > 0}
                              size="sm"
                              disabled={disabled}
                              value={skill[field]}
                              onChange={(event) => {
                                setExpandedIndex(index);
                                onChange(
                                  updateExpertSkillReference(skills, index, {
                                    [field]: event.target.value,
                                  }),
                                );
                              }}
                            />
                            {fieldIssues.map((issue) => (
                              <span
                                key={issue.message}
                                className="block text-ui-xs text-destructive"
                                role="alert"
                              >
                                {issue.message}
                              </span>
                            ))}
                          </label>
                        );
                      })}
                    </div>
                  </CollapsiblePanel>
                </Collapsible>
              </li>
            );
          })}
        </ul>
      ) : null}
    </SettingsSectionShell>
  );
}
