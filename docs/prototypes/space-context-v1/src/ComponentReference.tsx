import { SpaceEditorDialog } from "synara-ui/components/SpaceEditorDialog";
import { useDemoAppearance } from "./appearance";

// QA source capture: render the actual unmodified business component in isolation.
// This route is not part of the product flow or connected to the demo adapter.
export function ComponentReference() {
  useDemoAppearance();
  return (
    <SpaceEditorDialog
      open={true}
      mode="edit"
      initialValue={{ name: "学术研究", icon: "bag" }}
      existingNames={["Void", "产品工作"]}
      onOpenChange={() => undefined}
      onSubmit={() => undefined}
    />
  );
}
