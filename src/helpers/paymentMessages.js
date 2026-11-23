const paymentHeading = /^(?:datos de pago(?:\s*(?:[-–—:]\s*)?pago m[oó]vil)?|pago m[oó]vil)\s*:?$/i
const bankField = /^(?:banco|c[oó]digo(?: del)? banco)\s*[:\-]/i
const phoneField = /^(?:tel[eé]fono|celular|n[uú]mero de tel[eé]fono)\s*[:\-]/i
const idField = /^(?:c[eé]dula(?: de identidad)?|c\.?\s*i\.?)\s*[:\-]/i

export function splitMobilePayment(response) {
    if (process.env.PAGO_MOVIL?.trim().toLowerCase() !== 'true') return [response]

    const lines = response.split(/\r?\n/)
    const fields = lines.map(line => line.trim().replace(/^[-•]\s+/, '').replace(/[*_`]/g, '').trim())
    const headingIndex = fields.findIndex(line => paymentHeading.test(line))
    if (headingIndex === -1) return [response]

    const headingIndexes = [headingIndex]
    const paymentLines = []
    for (let index = headingIndex + 1; index < fields.length; index++) {
        const line = fields[index]
        if (!line) continue
        if (paymentHeading.test(line)) {
            headingIndexes.push(index)
            continue
        }

        const isPaymentField = bankField.test(line) || phoneField.test(line) || idField.test(line)
        if (!isPaymentField && !/^[\d. -]+$/.test(line)) break
        paymentLines.push({ index, line })
    }

    const bank = paymentLines.find(({ line }) => bankField.test(line) || /^\d{4}$/.test(line))
    const phone = paymentLines.find(({ line }) => phoneField.test(line) || /^04[\d -]+$/.test(line))
    const id = paymentLines.find(({ index, line }) =>
        index !== bank?.index && index !== phone?.index && (idField.test(line) || /^[\d. ]+$/.test(line))
    )

    const bankCode = bank?.line.match(/\b0\d{3}\b/)?.[0]
    const phoneNumber = phone?.line.replace(/\D/g, '')
    const idNumber = id?.line.replace(/\D/g, '')
    if (!bankCode || !/^04\d{9}$/.test(phoneNumber ?? '') || !/^\d{5,9}$/.test(idNumber ?? '')) {
        return [response]
    }

    const paymentIndexes = new Set([...headingIndexes, bank.index, phone.index, id.index])
    const confirmation = lines.filter((_, index) => !paymentIndexes.has(index))
        .join('\n').replace(/\n(?:[ \t]*\n){2,}/g, '\n\n').trim()

    return [confirmation, [idNumber, bankCode, phoneNumber].join('\n')]
}
