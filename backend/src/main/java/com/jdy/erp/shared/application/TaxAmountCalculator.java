package com.jdy.erp.shared.application;

import java.math.BigDecimal;
import java.math.RoundingMode;

import org.springframework.stereotype.Component;

@Component
public class TaxAmountCalculator {
    private static final BigDecimal ONE_HUNDRED = new BigDecimal("100");
    private static final BigDecimal DEFAULT_TAX_RATE = new BigDecimal("13");

    public TaxAmounts calculate(BigDecimal qty, BigDecimal unitPrice, BigDecimal taxRate, boolean taxInclusive) {
        var safeQty = valueOrZero(qty);
        var safeUnitPrice = valueOrZero(unitPrice);
        var safeTaxRate = taxRate == null ? DEFAULT_TAX_RATE : taxRate;
        var grossLineAmount = safeQty.multiply(safeUnitPrice);
        var rateRatio = safeTaxRate.divide(ONE_HUNDRED, 8, RoundingMode.HALF_UP);
        BigDecimal netAmount;
        BigDecimal priceTaxTotal;
        if (taxInclusive) {
            priceTaxTotal = scaleMoney(grossLineAmount);
            netAmount = scaleMoney(grossLineAmount.divide(BigDecimal.ONE.add(rateRatio), 8, RoundingMode.HALF_UP));
        } else {
            netAmount = scaleMoney(grossLineAmount);
            priceTaxTotal = scaleMoney(netAmount.multiply(BigDecimal.ONE.add(rateRatio)));
        }
        var taxAmount = scaleMoney(priceTaxTotal.subtract(netAmount));
        return new TaxAmounts(safeTaxRate, netAmount, taxAmount, priceTaxTotal);
    }

    private BigDecimal valueOrZero(BigDecimal value) {
        return value == null ? BigDecimal.ZERO : value;
    }

    private BigDecimal scaleMoney(BigDecimal value) {
        return value.setScale(2, RoundingMode.HALF_UP);
    }

    public record TaxAmounts(
        BigDecimal taxRate,
        BigDecimal amount,
        BigDecimal taxAmount,
        BigDecimal priceTaxTotal
    ) {
    }
}
