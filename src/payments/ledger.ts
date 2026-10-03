const shared =
  'p.id AS paymentId,p.flat_id AS flatId,cm.user_id AS collectedByUserId,r.receipt_number AS receiptNumber';
const joins =
  ' JOIN payments p ON p.society_id=x.society_id AND p.id=x.payment_id LEFT JOIN society_memberships cm ON cm.society_id=p.society_id AND cm.id=p.collected_by_membership_id LEFT JOIN receipts r ON r.society_id=p.society_id AND r.payment_id=p.id';
// Three tenant values are required in union order. Historical returns keep their event dates.
export const collectionLedger = `SELECT p.id,'COLLECTION' AS kind,p.payment_date AS eventDate,p.method,p.reference,p.amount,${shared},'BUSINESS_DATE' AS dateSource FROM payments p LEFT JOIN society_memberships cm ON cm.society_id=p.society_id AND cm.id=p.collected_by_membership_id LEFT JOIN receipts r ON r.society_id=p.society_id AND r.payment_id=p.id WHERE p.society_id=?
 UNION ALL SELECT x.id,'REFUND',x.refund_date,x.method,x.reference,-x.amount,${shared},'BUSINESS_DATE' FROM payment_refunds x ${joins} WHERE x.society_id=?
 UNION ALL SELECT x.id,'REVERSAL',COALESCE(d.operation_date,DATE(x.created_at)),p.method,p.reference,-p.amount,${shared},IF(d.operation_date IS NULL,'LEGACY_UTC','BUSINESS_DATE') FROM payment_reversals x ${joins} LEFT JOIN payment_reversal_details d ON d.society_id=x.society_id AND d.reversal_id=x.id WHERE x.society_id=?`;
