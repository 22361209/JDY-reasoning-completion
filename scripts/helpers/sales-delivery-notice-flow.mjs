export function salesOutPayloadViaDeliveryNotice(payload, noticeBillNo) {
  const noticeNo = noticeBillNo || `FHTZ-${payload.billNo}`;
  const noticePayload = {
    billNo: noticeNo,
    sourceOrderNo: payload.sourceOrderNo || "",
    customerCode: payload.customerCode,
    billDate: payload.billDate,
    department: payload.department,
    ownerName: payload.ownerName,
    remark: payload.remark,
    isTaxInclusive: payload.isTaxInclusive,
    lines: payload.lines.map((line, index) => ({
      ...line,
      sourceOrderNo: line.sourceOrderNo || payload.sourceOrderNo || "",
      sourceLineNo: line.sourceLineNo || index + 1
    }))
  };
  const outPayload = {
    ...payload,
    sourceOrderNo: noticeNo,
    lines: payload.lines.map((line, index) => ({
      ...line,
      sourceOrderNo: noticeNo,
      sourceLineNo: index + 1,
      sourceDeliveryNoticeNo: noticeNo,
      sourceDeliveryLineNo: index + 1
    }))
  };
  return { noticeNo, noticePayload, outPayload };
}

export async function createSalesOutDraftViaDeliveryNotice(postJson, payload, noticeBillNo) {
  const flow = salesOutPayloadViaDeliveryNotice(payload, noticeBillNo);
  await postJson("/api/delivery-notices/draft", flow.noticePayload);
  await postJson(`/api/delivery-notices/${encodeURIComponent(flow.noticeNo)}/audit`);
  await postJson("/api/sales-outs/draft", flow.outPayload);
  return flow;
}
