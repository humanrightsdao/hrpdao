// Stubs for the Lens SDK / client so pure moderation logic can be unit-tested offline.
export const evmAddress = (a) => a;
export const postId = (a) => a;
// Tests can script Lens pages: globalThis.__fetchPosts = async (request) => ({ items, next })
export const fetchPosts = async (client, request) => {
  if (globalThis.__fetchPosts) {
    const r = await globalThis.__fetchPosts(request);
    if (r.error) return { isErr: () => true, error: { message: r.error } };
    return { isErr: () => false, value: { items: r.items, pageInfo: { next: r.next || null } } };
  }
  return { isErr: () => false, value: { items: [], pageInfo: {} } };
};
export const fetchPost = async () => ({ isErr: () => true });
export const lensClient = {};
