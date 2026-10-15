// The prototype never enumerates or captures real desktop windows.
export function useAppSnapWindows() {
  return {
    available: false,
    busy: false,
    windows: null,
    unavailableMessage: null,
    captureWindow: () => undefined,
  };
}
