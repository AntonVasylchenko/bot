require('dotenv').config();
const client = require("./Api/index.js");

const STEP_START = "start";
const STEP_WAIT = "wait";
const STEP_HOLD = "hold";
const STEP_SELL = "sell";
const STEP_BUY = "buy";

class BinaneHelper {
  constructor() {

    this.baseCoin = process.env.BASE_COIN;
    this.quoteCoin = process.env.QUOTE_COIN;
    this.pairSymbol = process.env.PAIR_SYMBOL;
    this.profit = process.env.PROFIT;

    this.soldPrice = 0
    this.buyPrice = 0

    this.isReady = false;
    this.tradingFee = null;
    this.tradingRules = null;
    this.status = STEP_START
    this.inTrade = false
    this.successfulTrades = 0;
    this.quantity = process.env.QUANTITY
    this.priceOnStart = null
    this.listLastPrice = []
  }

  async getPrice(symbol) {
    const ticker = await client.prices({ symbol });
    return parseFloat(ticker[symbol]);
  }

  async getCoinBalance(symbol) {
    const balance = await client.accountInfo();
    const coinBalance = balance.balances.find(b => b.asset === symbol);
    return parseFloat(coinBalance.free);
  }

  async getTradingRules(symbol) {
    try {
      const exchangeInfo = await client.exchangeInfo();
      const pairInfo = exchangeInfo.symbols.find((item) => item.symbol === symbol);

      if (!pairInfo) {
        console.log(`Symbol ${symbol} не знайдено`);
        return;
      }

      const filters = pairInfo.filters.reduce((acc, filter) => {
        if (filter.filterType === 'LOT_SIZE') {
          acc.minQty = filter.minQty;
        }
        if (filter.filterType === 'MIN_NOTIONAL') {
          acc.minNotional = filter.minNotional;
        }
        return acc;
      }, {});

      return {
        symbol: pairInfo.symbol,
        baseAsset: pairInfo.baseAsset,
        quoteAsset: pairInfo.quoteAsset,
        minQty: filters.minQty || 'N/A',
        minNotional: filters.minNotional || 'N/A',
      };
    } catch (error) {
      console.error('Помилка під час отримання інформації:', error);
    }
  }

  async getTradeFee(symbol) {
    try {
      const tradeFee = await client.tradeFee({ symbol });
      return JSON.parse(JSON.stringify(tradeFee, null, 2))
    } catch (error) {
      console.error('Error fetching trade fee:', error);
    }
  }

  async getSymbolInfo(symbol) {
    const exchangeInfo = await client.exchangeInfo();
    const symbolInfo = exchangeInfo.symbols.find(s => s.symbol === this.pairSymbol);
    return symbolInfo;
  }

  async sellCoins(quantity) {
    try {
      await client.order({
        symbol: this.pairSymbol,
        side: 'SELL',
        type: 'MARKET',
        quantity,
      });
      this.successfulTrades++
    } catch (error) {
      console.error('Error selling Coins:', error);
    }
  }

  async buyCoins(usdtAmount, currentPrice) {
    try {
      const commissionRate = 0.001;
      const amountAfterCommission = usdtAmount * (1 - commissionRate);
      let quantityToBuy = amountAfterCommission / currentPrice;

      const symbolInfo = await client.exchangeInfo();
      const symbolData = symbolInfo.symbols.find(s => s.symbol === this.pairSymbol);
      const lotSizeFilter = symbolData.filters.find(f => f.filterType === 'LOT_SIZE');
      const quantityPrecision = lotSizeFilter.stepSize;
      const stepSize = quantityPrecision.toString().split('1')[1].length;

      quantityToBuy = Math.floor(quantityToBuy * Math.pow(10, stepSize)) / Math.pow(10, stepSize);

      await client.order({
        symbol: this.pairSymbol,
        side: 'BUY',
        type: 'MARKET',
        quantity: quantityToBuy.toFixed(0)
      });
    } catch (error) {
      console.error('Error buying Coins:', error);
    }
  }

  priceCorrection(currentPrice) {
    this.listLastPrice.push(currentPrice);

    if (this.listLastPrice.length < 4) {
      this.priceOnStart = null;
      return null
    };
    const fullPrice = this.listLastPrice.reduce((accumulator, currentValue) => {
      return accumulator + Number(currentValue);
    }, 0)

    this.priceOnStart = fullPrice / this.listLastPrice.length;
  }
  getSoldPrice(pricePerCoin, profit, fee) {
    const priceWithProfit = Number(pricePerCoin) * Number(profit);
    const feeAmount = priceWithProfit * Number(fee);
    const size = this.getDecimalPlaces(pricePerCoin);
    return Number((priceWithProfit + feeAmount).toFixed(size));
  }

  getBuyPrice(pricePerSoldedCoin, profit, fee) {
    const priceAfterPercent = Number(pricePerSoldedCoin) * (1 - Number(profit - 1));
    const feeAmount = priceAfterPercent * Number(fee);
    const priceAfterFee = priceAfterPercent - feeAmount;
    const size = this.getDecimalPlaces(pricePerSoldedCoin);
    return Number(priceAfterFee.toFixed(size));
  }

  getDecimalPlaces(number) {
    const decimalPart = number.toString().split('.')[1];
    return decimalPart ? decimalPart.length : 0;
  }

  delay(ms = 3000) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }



}

const binaneHelper = new BinaneHelper();



async function trade() {

  const isReady = binaneHelper.isReady;
  const currentPriceBaceCoin = await binaneHelper.getPrice(binaneHelper.pairSymbol);
  const tradingRules = await binaneHelper.getTradingRules(binaneHelper.pairSymbol);
  const tradingFee = await binaneHelper.getTradeFee(binaneHelper.pairSymbol);

  binaneHelper.tradingRules = tradingRules;
  binaneHelper.tradingFee = tradingFee;
  binaneHelper.isReady = true
  const { makerCommission: sellFee, takerCommission: soldFee } = binaneHelper.tradingFee[0];

  if (!isReady) {
    binaneHelper.soldPrice = binaneHelper.getSoldPrice(currentPriceBaceCoin, binaneHelper.profit, soldFee);
    binaneHelper.buyPrice = binaneHelper.getBuyPrice(currentPriceBaceCoin, 1, sellFee);
    trade()
    return
  }

  const baseBalance = await binaneHelper.getCoinBalance(binaneHelper.baseCoin);
  const quoteBalance = await binaneHelper.getCoinBalance(binaneHelper.quoteCoin);


  const { minQty, minNotional } = binaneHelper.tradingRules;

  const priceSoldCoin = binaneHelper.soldPrice
  const priceBuyCoin = binaneHelper.buyPrice

  // console.log("priceSoldCoin", priceSoldCoin);
  // console.log("priceBuyCoin", priceBuyCoin);
  // console.log("currentPriceBaceCoin", currentPriceBaceCoin);


  if (binaneHelper.status !== STEP_START && binaneHelper.inTrade === true && currentPriceBaceCoin >= priceSoldCoin) {
    binaneHelper.status = STEP_SELL
  }

  if (binaneHelper.status !== STEP_START && binaneHelper.inTrade === true && currentPriceBaceCoin <= priceSoldCoin) {
    binaneHelper.status = STEP_HOLD
  }

  if (binaneHelper.status !== STEP_START && binaneHelper.inTrade === false && currentPriceBaceCoin <= priceBuyCoin) {
    binaneHelper.status = STEP_BUY
  }

  if (binaneHelper.status !== STEP_START && binaneHelper.inTrade === false && currentPriceBaceCoin >= priceBuyCoin) {
    binaneHelper.status = STEP_WAIT
  }

  switch (binaneHelper.status) {
    case STEP_START: {
      console.log(`Waiting best price for buying. Target price for buying is ${priceBuyCoin}, but Current price per token is ${currentPriceBaceCoin}`);
      binaneHelper.status = quoteBalance >= 1 ? STEP_BUY : STEP_SELL
      binaneHelper.inTrade = binaneHelper.status === STEP_SELL
      break;
    }
    case STEP_WAIT: {
      console.log(`Waiting best price for buying. Target price for buying is ${priceBuyCoin}, but Current price per token is ${currentPriceBaceCoin}`);
      binaneHelper.inTrade = false
      break;
    }
    case STEP_HOLD: {
      console.log(`Holding best price for selling. Target price for selling is ${priceSoldCoin}, but Current price per token is ${currentPriceBaceCoin}`);
      binaneHelper.inTrade = true
      break;
    }
    case STEP_SELL: {
      const quantity = baseBalance ? baseBalance.toFixed(0) : binaneHelper.quantity
      await binaneHelper.sellCoins(quantity);
      binaneHelper.soldPrice = binaneHelper.getSoldPrice(currentPriceBaceCoin, binaneHelper.profit, soldFee);
      console.log(`Wait for selling`);
      console.log(`Selled ${quantity} coins for ${currentPriceBaceCoin} per one coin `);
      binaneHelper.inTrade = false
      break;
    }
    case STEP_BUY: {
      await binaneHelper.buyCoins(quoteBalance, currentPriceBaceCoin)
      binaneHelper.buyPrice = binaneHelper.getBuyPrice(currentPriceBaceCoin, binaneHelper.profit, sellFee);
      console.log(`Wait for buying`);
      console.log(`Purchased ${quoteBalance} coins for ${currentPriceBaceCoin} per one coin `);
      binaneHelper.inTrade = true
      binaneHelper.status = STEP_HOLD
      break;
    }

    default:
      break;
  }



  await binaneHelper.delay(process.env.SPEED_TRADE)
  console.log(binaneHelper.status,binaneHelper.inTrade);
  
  trade()
}

trade()