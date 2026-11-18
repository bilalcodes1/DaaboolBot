/**
 * Public-template defaults. Configure the owner and destinations in D1 before
 * deploying a private instance; production identifiers are intentionally not
 * shipped in this repository.
 */
export const PRIMARY_ADMIN = 0;
export const SECONDARY_ADMIN = 0;
export const DISCUSSION_GROUP = 0;
export const DISCUSSION_CHANNEL = 0;
export function sharesDestination(scopeChatId:number|undefined,targetChatId:number):boolean {
  return scopeChatId===undefined||scopeChatId>0||scopeChatId===targetChatId
    || scopeChatId===DISCUSSION_GROUP&&targetChatId===DISCUSSION_CHANNEL;
}
export function isAdmin(userId: number | undefined, ownerUid: number | null): boolean {
  return userId !== undefined && userId > 0 && ownerUid !== null && ownerUid > 0
    && (userId === ownerUid || ownerUid === PRIMARY_ADMIN && userId === SECONDARY_ADMIN);
}
