UPDATE purchase_requisition_line line
SET ordered_qty = COALESCE((
    SELECT SUM(po_line.qty)
    FROM purchase_requisition req
    JOIN purchase_order_line po_line
      ON po_line.source_requisition_no = req.bill_no
     AND po_line.source_requisition_line_no = line.line_no
    JOIN purchase_order po ON po.id = po_line.order_id
    WHERE req.id = line.requisition_id
      AND po.status = 'AUDITED'
), 0);
