import { useCallback, useEffect, useRef, useState } from "react";

type OperationKind = "write" | "impact";
type Operation = { readonly generation: number; readonly kind: OperationKind };

/** An async result owns one view generation, even when the same connection is reopened. */
export function useMcpOperationScope() {
  const generation = useRef(0);
  const mounted = useRef(true);
  const active = useRef<Operation | null>(null);
  const [kind, setKind] = useState<OperationKind | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      active.current = null;
    };
  }, []);

  const capture = useCallback(() => generation.current, []);
  const isViewCurrent = useCallback(
    (value: number) => mounted.current && generation.current === value,
    [],
  );
  const isCurrent = useCallback(
    (operation: Operation) =>
      mounted.current &&
      active.current === operation &&
      generation.current === operation.generation,
    [],
  );
  const begin = useCallback((nextKind: OperationKind): Operation | null => {
    if (!mounted.current || active.current) return null;
    const operation = { generation: generation.current, kind: nextKind };
    active.current = operation;
    setKind(nextKind);
    return operation;
  }, []);
  const finish = useCallback((operation: Operation) => {
    if (active.current !== operation || !mounted.current) return;
    active.current = null;
    setKind(null);
  }, []);
  const invalidate = useCallback(() => {
    generation.current += 1;
    active.current = null;
    if (mounted.current) setKind(null);
  }, []);

  return {
    begin,
    capture,
    finish,
    invalidate,
    isCurrent,
    isViewCurrent,
    pending: kind === "write",
    loadingImpact: kind === "impact",
  };
}
