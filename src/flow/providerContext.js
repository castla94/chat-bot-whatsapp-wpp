const lidPhoneCache = new Map();

const normalizeWidValue = (wid) => {
    if (!wid) {
        return '';
    }

    const serialized = String(wid?._serialized ?? '').trim();
    if (serialized) {
        return serialized.split('@')[0];
    }

    const id = String(wid?.id ?? '').trim();
    if (id) {
        return id;
    }

    return '';
};

const getNumberCandidates = (ctx) => {
    return [
        ctx?.from,
        ctx?.chatId,
        ctx?.sender?.id,
        ctx?.author,
    ];
};

export const extractUserId = (ctx) => {
    return String(ctx?.id ?? ctx?.chatId ?? ctx?.from ?? 'unknown');
};

export const extractNumber = (ctx) => {
    for (const candidate of getNumberCandidates(ctx)) {
        const value = String(candidate ?? '').trim();
        if (!value) {
            continue;
        }

        const cleanNumber = value.split('@')[0];
        if (cleanNumber) {
            return cleanNumber;
        }
    }

    return '';
};

export const resolveNumber = async (provider, ctx) => {
    const fallbackNumber = extractNumber(ctx);

    for (const candidate of getNumberCandidates(ctx)) {
        const value = String(candidate ?? '').trim();
        if (!value) {
            continue;
        }

        if (!value.includes('@lid') && !value.includes('@hosted.lid')) {
            continue;
        }

        if (lidPhoneCache.has(value)) {
            return lidPhoneCache.get(value);
        }

        if (typeof provider?.vendor?.getPnLidEntry !== 'function') {
            return fallbackNumber;
        }

        try {
            const lidEntry = await provider.vendor.getPnLidEntry(value);
            const realNumber = normalizeWidValue(lidEntry?.phoneNumber);

            if (realNumber) {
                lidPhoneCache.set(value, realNumber);
                return realNumber;
            }
        } catch {
            return fallbackNumber;
        }
    }

    return fallbackNumber;
};

export const extractName = (ctx) => {
    const candidates = [
        ctx?.pushName,
        ctx?.notifyName,
        ctx?.name,
        ctx?.sender?.pushname,
        ctx?.author,
    ];

    for (const candidate of candidates) {
        const value = String(candidate ?? '').trim();
        if (value) {
            return value;
        }
    }

    return '';
};

export const getChatId = (ctx) => {
    const candidates = [
        ctx?.chatId,
        ctx?.from,
        ctx?.sender?.id,
    ];

    for (const candidate of candidates) {
        const value = String(candidate ?? '').trim();
        if (!value) {
            continue;
        }

        if (value.includes('@')) {
            return value;
        }

        return `${value}@c.us`;
    }

    return '';
};

export const markMessageSeen = async (provider, ctx) => {
    const chatId = getChatId(ctx);
    if (!chatId) {
        return;
    }

    if (typeof provider?.vendor?.sendSeen === 'function') {
        await provider.vendor.sendSeen(chatId);
    }
};
