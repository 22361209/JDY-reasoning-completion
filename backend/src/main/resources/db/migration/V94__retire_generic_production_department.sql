UPDATE md_product product
SET default_workshop = '',
    default_workshop_id = NULL,
    updated_at = now(),
    version = product.version + 1
FROM md_production_department department
WHERE product.default_workshop_id = department.id
  AND department.code NOT IN ('AZ', 'BZ', 'CY', 'HJ', 'JG');

UPDATE md_product
SET default_workshop = '',
    default_workshop_id = NULL,
    updated_at = now(),
    version = version + 1
WHERE default_workshop_id IS NULL
  AND trim(COALESCE(default_workshop, '')) <> ''
  AND default_workshop NOT IN ('安装车间', '包装车间', '冲压车间', '焊接车间', '金工车间');

DELETE FROM md_production_department
WHERE code NOT IN ('AZ', 'BZ', 'CY', 'HJ', 'JG');
