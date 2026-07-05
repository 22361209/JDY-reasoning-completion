package com.jdy.erp.shared.application;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;

import org.junit.jupiter.api.Test;

class TaxAmountCalculatorTest {
    private final TaxAmountCalculator calculator = new TaxAmountCalculator();

    @Test
    void calculatesExclusiveTaxAmounts() {
        var amounts = calculator.calculate(new BigDecimal("2"), new BigDecimal("100"), new BigDecimal("13"));

        assertThat(amounts.amount()).isEqualByComparingTo("200.00");
        assertThat(amounts.taxAmount()).isEqualByComparingTo("26.00");
        assertThat(amounts.priceTaxTotal()).isEqualByComparingTo("226.00");
    }

    @Test
    void treatsUnitPriceAsExclusiveTaxPrice() {
        var amounts = calculator.calculate(new BigDecimal("1"), new BigDecimal("113"), new BigDecimal("13"));

        assertThat(amounts.amount()).isEqualByComparingTo("113.00");
        assertThat(amounts.taxAmount()).isEqualByComparingTo("14.69");
        assertThat(amounts.priceTaxTotal()).isEqualByComparingTo("127.69");
    }

    @Test
    void defaultsNullValuesSafely() {
        var amounts = calculator.calculate(null, null, null);

        assertThat(amounts.taxRate()).isEqualByComparingTo("13");
        assertThat(amounts.amount()).isEqualByComparingTo("0.00");
        assertThat(amounts.taxAmount()).isEqualByComparingTo("0.00");
        assertThat(amounts.priceTaxTotal()).isEqualByComparingTo("0.00");
    }
}
