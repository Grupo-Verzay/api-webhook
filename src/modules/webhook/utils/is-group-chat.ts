export function isGroupChat(remoteJid: string): boolean {
    return remoteJid.endsWith('@g.us');
}
