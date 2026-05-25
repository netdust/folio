import { useQuery } from '@tanstack/react-query';
import { client } from './client.ts';

export interface Member {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
}

export const membersKeys = {
  list: (wslug: string) => ['members', wslug] as const,
};

export function useMembers(wslug: string) {
  return useQuery({
    queryKey: membersKeys.list(wslug),
    queryFn: async () => {
      const wrapped = await client.get<{ members: Member[] }>(
        `/api/v1/w/${wslug}/members`,
      );
      return wrapped.members;
    },
    staleTime: 60_000,
    enabled: !!wslug,
  });
}
