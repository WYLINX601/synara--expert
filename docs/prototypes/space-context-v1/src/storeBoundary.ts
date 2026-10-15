// Native rows can import the production store, but this fixture cannot hydrate it.
function rejectStoreAccess(): never {
  throw new Error("交互原型不能读取或修改正式工作区状态。");
}

export const useStore = Object.assign(rejectStoreAccess, {
  getState: rejectStoreAccess,
  setState: rejectStoreAccess,
  subscribe: rejectStoreAccess,
});
