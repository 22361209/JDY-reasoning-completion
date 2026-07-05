export async function createSalesOutDraftViaDeliveryNotice(postJson, payload) {
  const noticePayload = withoutBillNo({
    sourceOrderNo: payload.sourceOrderNo || "",
    customerCode: payload.customerCode,
    billDate: payload.billDate,
    department: payload.department,
    ownerName: payload.ownerName,
    remark: payload.remark,
    lines: payload.lines.map((line, index) => ({
      ...line,
      sourceOrderNo: line.sourceOrderNo || payload.sourceOrderNo || "",
      sourceLineNo: line.sourceLineNo || index + 1
    }))
  });
  const noticeDraft = await postJson("/api/delivery-notices/draft", noticePayload);
  const noticeNo = String(noticeDraft.billNo);
  await postJson(`/api/delivery-notices/${encodeURIComponent(noticeNo)}/audit`);
  const outPayload = withoutBillNo({
    ...payload,
    sourceOrderNo: noticeNo,
    lines: payload.lines.map((line, index) => ({
      ...line,
      sourceOrderNo: noticeNo,
      sourceLineNo: index + 1,
      sourceDeliveryNoticeNo: noticeNo,
      sourceDeliveryLineNo: index + 1
    }))
  });
  const salesOutDraft = await postJson("/api/sales-outs/draft", outPayload);
  return { noticeNo, noticePayload, outPayload, noticeDraft, salesOutDraft, salesOutNo: String(salesOutDraft.billNo) };
}

function withoutBillNo(payload) {
  const { billNo, ...rest } = payload;
  return rest;
}
