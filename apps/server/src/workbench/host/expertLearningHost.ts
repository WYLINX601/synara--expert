// The Workbench host owns learning lifecycle; feature RPC and background ticks
// share the same native evolution services and persistence capabilities.
export { createExpertLearningService as createExpertLearningHost } from "../../experts/evolution/ExpertLearningService";
