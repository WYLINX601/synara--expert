import { useTranslation } from "~/i18n";
import { DetailTabs } from "../ui/DetailTabs";

export type ComposerMentionTab = "files" | "context";

/** Keep the editor selection while either mention list owns keyboard navigation. */
export function ComposerMentionTabs({
  value,
  onChange,
}: {
  value: ComposerMentionTab;
  onChange: (tab: ComposerMentionTab) => void;
}) {
  const { t } = useTranslation();
  return (
    <div onMouseDown={(event) => event.preventDefault()}>
      <DetailTabs
        id="composer-mention"
        label={t("chat:ambientMentionType")}
        tabs={[
          { value: "files", label: t("chat:ambientMentionFiles") },
          { value: "context", label: t("chat:ambientMentionContext") },
        ]}
        value={value}
        onChange={onChange}
        className="gap-4 px-3"
      />
    </div>
  );
}
