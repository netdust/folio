import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';

export interface UseOptimisticPatchOptions<TData, TVars> {
  detailKey: (vars: TVars) => QueryKey;
  listKey?: QueryKey;
  mutationFn: (vars: TVars) => Promise<TData>;
  applyToDetail: (prev: TData, vars: TVars) => TData;
  applyToList?: (prev: TData[], vars: TVars) => TData[];
}

export function useOptimisticPatch<TData, TVars>(opts: UseOptimisticPatchOptions<TData, TVars>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: opts.mutationFn,
    onMutate: async (vars) => {
      const detail = opts.detailKey(vars);
      await qc.cancelQueries({ queryKey: detail });
      if (opts.listKey) await qc.cancelQueries({ queryKey: opts.listKey });
      const prevDetail = qc.getQueryData<TData>(detail);
      const prevList = opts.listKey ? qc.getQueryData<TData[]>(opts.listKey) : undefined;
      if (prevDetail !== undefined) {
        qc.setQueryData(detail, opts.applyToDetail(prevDetail, vars));
      }
      if (opts.listKey && opts.applyToList && prevList !== undefined) {
        qc.setQueryData(opts.listKey, opts.applyToList(prevList, vars));
      }
      return { prevDetail, prevList, detail };
    },
    onError: (_err, _vars, ctx) => {
      if (!ctx) return;
      if (ctx.prevDetail !== undefined) qc.setQueryData(ctx.detail, ctx.prevDetail);
      if (opts.listKey && ctx.prevList !== undefined) qc.setQueryData(opts.listKey, ctx.prevList);
    },
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: opts.detailKey(vars) });
      if (opts.listKey) qc.invalidateQueries({ queryKey: opts.listKey });
    },
  });
}
