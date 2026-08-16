import {
  createAddonModuleLocaleBundles,
  type AddonModuleLocaleMessages,
} from '../../../i18n/addonModuleLocale';
import { ADDON_COMMON_MESSAGES } from '../locales/common';

export const CAULDRON_MODULE_ID = 'cauldron' as const;

const messages: AddonModuleLocaleMessages = {
  en: {
    'module.title': 'Cauldron',
    'module.flipDirection': 'Flip swap direction',
    'module.syncingPool': 'Syncing pool data from the indexer',
    'module.poolSynced': 'Pool data synced from the indexer',
    'module.liquidity': 'Liquidity',
    'module.noLps': 'No LPs.',
    'module.reviewSwap': 'Review Cauldron swap',
    'module.reviewWarnings': 'Review warnings, then slide.',
    'module.slideConfirm': 'Slide to confirm.',
    'module.pay': 'Pay',
    'module.receive': 'Receive',
    'module.minimumReceive': 'Minimum receive',
    'module.pools': 'Pools',
    'module.poolBch': 'Pool BCH',
    'module.poolToken': 'Pool token',
    'module.withdrawBch': 'Withdraw BCH',
    'module.withdrawToken': 'Withdraw token',
    'module.estimatedFee': 'Estimated network fee',
    'module.bchReserve': 'BCH reserve',
    'module.feeApy': 'Fee-based APY',
  },
  es: {
    'module.title': 'Cauldron',
    'module.flipDirection': 'Invertir dirección del intercambio',
    'module.syncingPool': 'Sincronizando datos del pool desde el indexador',
    'module.poolSynced': 'Datos del pool sincronizados desde el indexador',
    'module.liquidity': 'Liquidez',
    'module.noLps': 'No hay proveedores de liquidez.',
    'module.reviewSwap': 'Revisar intercambio de Cauldron',
    'module.reviewWarnings': 'Revisa las advertencias y desliza.',
    'module.slideConfirm': 'Desliza para confirmar.',
    'module.pay': 'Pagar',
    'module.receive': 'Recibir',
    'module.minimumReceive': 'Mínimo a recibir',
    'module.pools': 'Pools',
    'module.poolBch': 'BCH del pool',
    'module.poolToken': 'Token del pool',
    'module.withdrawBch': 'Retirar BCH',
    'module.withdrawToken': 'Retirar token',
    'module.estimatedFee': 'Comisión de red estimada',
    'module.bchReserve': 'Reserva de BCH',
    'module.feeApy': 'APY por comisiones',
  },
  'pt-BR': {
    'module.title': 'Cauldron',
    'module.flipDirection': 'Inverter direção da troca',
    'module.syncingPool': 'Sincronizando dados do pool pelo indexador',
    'module.poolSynced': 'Dados do pool sincronizados pelo indexador',
    'module.liquidity': 'Liquidez',
    'module.noLps': 'Nenhum provedor de liquidez.',
    'module.reviewSwap': 'Revisar troca do Cauldron',
    'module.reviewWarnings': 'Revise os avisos e deslize.',
    'module.slideConfirm': 'Deslize para confirmar.',
    'module.pay': 'Pagar',
    'module.receive': 'Receber',
    'module.minimumReceive': 'Mínimo a receber',
    'module.pools': 'Pools',
    'module.poolBch': 'BCH do pool',
    'module.poolToken': 'Token do pool',
    'module.withdrawBch': 'Sacar BCH',
    'module.withdrawToken': 'Sacar token',
    'module.estimatedFee': 'Taxa de rede estimada',
    'module.bchReserve': 'Reserva de BCH',
    'module.feeApy': 'APY baseado em taxas',
  },
  'zh-CN': {
    'module.title': 'Cauldron',
    'module.flipDirection': '切换兑换方向',
    'module.syncingPool': '正在从索引器同步池数据',
    'module.poolSynced': '池数据已从索引器同步',
    'module.liquidity': '流动性',
    'module.noLps': '没有流动性提供者。',
    'module.reviewSwap': '审核 Cauldron 兑换',
    'module.reviewWarnings': '查看警告后滑动确认。',
    'module.slideConfirm': '滑动确认。',
    'module.pay': '支付',
    'module.receive': '接收',
    'module.minimumReceive': '最低接收量',
    'module.pools': '池',
    'module.poolBch': '池 BCH',
    'module.poolToken': '池代币',
    'module.withdrawBch': '提取 BCH',
    'module.withdrawToken': '提取代币',
    'module.estimatedFee': '预计网络费',
    'module.bchReserve': 'BCH 储备',
    'module.feeApy': '基于费用的 APY',
  },
  'zh-TW': {
    'module.title': 'Cauldron',
    'module.flipDirection': '切換兌換方向',
    'module.syncingPool': '正在從索引器同步池資料',
    'module.poolSynced': '池資料已從索引器同步',
    'module.liquidity': '流動性',
    'module.noLps': '沒有流動性提供者。',
    'module.reviewSwap': '檢視 Cauldron 兌換',
    'module.reviewWarnings': '檢視警告後滑動確認。',
    'module.slideConfirm': '滑動確認。',
    'module.pay': '支付',
    'module.receive': '接收',
    'module.minimumReceive': '最低接收量',
    'module.pools': '池',
    'module.poolBch': '池 BCH',
    'module.poolToken': '池代幣',
    'module.withdrawBch': '提取 BCH',
    'module.withdrawToken': '提取代幣',
    'module.estimatedFee': '預估網路費',
    'module.bchReserve': 'BCH 儲備',
    'module.feeApy': '依費用計算的 APY',
  },
  vi: {
    'module.title': 'Cauldron',
    'module.flipDirection': 'Đảo chiều hoán đổi',
    'module.syncingPool': 'Đang đồng bộ dữ liệu pool từ bộ lập chỉ mục',
    'module.poolSynced': 'Đã đồng bộ dữ liệu pool từ bộ lập chỉ mục',
    'module.liquidity': 'Thanh khoản',
    'module.noLps': 'Không có nhà cung cấp thanh khoản.',
    'module.reviewSwap': 'Xem lại hoán đổi Cauldron',
    'module.reviewWarnings': 'Xem cảnh báo rồi vuốt.',
    'module.slideConfirm': 'Vuốt để xác nhận.',
    'module.pay': 'Thanh toán',
    'module.receive': 'Nhận',
    'module.minimumReceive': 'Mức nhận tối thiểu',
    'module.pools': 'Pool',
    'module.poolBch': 'BCH trong pool',
    'module.poolToken': 'Token trong pool',
    'module.withdrawBch': 'Rút BCH',
    'module.withdrawToken': 'Rút token',
    'module.estimatedFee': 'Phí mạng ước tính',
    'module.bchReserve': 'Dự trữ BCH',
    'module.feeApy': 'APY theo phí',
  },
  ar: {
    'module.title': 'Cauldron',
    'module.flipDirection': 'عكس اتجاه المبادلة',
    'module.syncingPool': 'جارٍ مزامنة بيانات المجمع من المفهرس',
    'module.poolSynced': 'تمت مزامنة بيانات المجمع من المفهرس',
    'module.liquidity': 'السيولة',
    'module.noLps': 'لا يوجد مزودو سيولة.',
    'module.reviewSwap': 'مراجعة مبادلة Cauldron',
    'module.reviewWarnings': 'راجع التحذيرات ثم اسحب.',
    'module.slideConfirm': 'اسحب للتأكيد.',
    'module.pay': 'الدفع',
    'module.receive': 'الاستلام',
    'module.minimumReceive': 'الحد الأدنى للاستلام',
    'module.pools': 'المجمعات',
    'module.poolBch': 'BCH في المجمع',
    'module.poolToken': 'رمز المجمع',
    'module.withdrawBch': 'سحب BCH',
    'module.withdrawToken': 'سحب الرمز',
    'module.estimatedFee': 'رسوم الشبكة المقدّرة',
    'module.bchReserve': 'احتياطي BCH',
    'module.feeApy': 'APY حسب الرسوم',
  },
  fr: {
    'module.title': 'Cauldron',
    'module.flipDirection': 'Inverser le sens de l’échange',
    'module.syncingPool':
      'Synchronisation des données du pool depuis l’indexeur',
    'module.poolSynced': 'Données du pool synchronisées depuis l’indexeur',
    'module.liquidity': 'Liquidité',
    'module.noLps': 'Aucun fournisseur de liquidité.',
    'module.reviewSwap': 'Vérifier l’échange Cauldron',
    'module.reviewWarnings':
      'Vérifiez les avertissements, puis faites glisser.',
    'module.slideConfirm': 'Faites glisser pour confirmer.',
    'module.pay': 'Payer',
    'module.receive': 'Recevoir',
    'module.minimumReceive': 'Réception minimale',
    'module.pools': 'Pools',
    'module.poolBch': 'BCH du pool',
    'module.poolToken': 'Token du pool',
    'module.withdrawBch': 'Retirer des BCH',
    'module.withdrawToken': 'Retirer le token',
    'module.estimatedFee': 'Frais réseau estimés',
    'module.bchReserve': 'Réserve de BCH',
    'module.feeApy': 'APY lié aux frais',
  },
  ko: {
    'module.title': 'Cauldron',
    'module.flipDirection': '교환 방향 전환',
    'module.syncingPool': '인덱서에서 풀 데이터를 동기화하는 중',
    'module.poolSynced': '인덱서에서 풀 데이터를 동기화했습니다',
    'module.liquidity': '유동성',
    'module.noLps': '유동성 공급자가 없습니다.',
    'module.reviewSwap': 'Cauldron 교환 검토',
    'module.reviewWarnings': '경고를 확인한 후 밀어서 진행합니다.',
    'module.slideConfirm': '밀어서 확인합니다.',
    'module.pay': '지불',
    'module.receive': '받기',
    'module.minimumReceive': '최소 수령량',
    'module.pools': '풀',
    'module.poolBch': '풀 BCH',
    'module.poolToken': '풀 토큰',
    'module.withdrawBch': 'BCH 출금',
    'module.withdrawToken': '토큰 출금',
    'module.estimatedFee': '예상 네트워크 수수료',
    'module.bchReserve': 'BCH 준비금',
    'module.feeApy': '수수료 기반 APY',
  },
  ja: {
    'module.title': 'Cauldron',
    'module.flipDirection': '交換方向を反転',
    'module.syncingPool': 'インデクサーからプールデータを同期中',
    'module.poolSynced': 'インデクサーからプールデータを同期しました',
    'module.liquidity': '流動性',
    'module.noLps': '流動性提供者はいません。',
    'module.reviewSwap': 'Cauldron交換を確認',
    'module.reviewWarnings': '警告を確認してからスライドします。',
    'module.slideConfirm': 'スライドして確認します。',
    'module.pay': '支払い',
    'module.receive': '受け取り',
    'module.minimumReceive': '最小受取量',
    'module.pools': 'プール',
    'module.poolBch': 'プールBCH',
    'module.poolToken': 'プールトークン',
    'module.withdrawBch': 'BCHを引き出す',
    'module.withdrawToken': 'トークンを引き出す',
    'module.estimatedFee': '推定ネットワーク手数料',
    'module.bchReserve': 'BCHリザーブ',
    'module.feeApy': '手数料ベースのAPY',
  },
  ru: {
    'module.title': 'Cauldron',
    'module.flipDirection': 'Изменить направление обмена',
    'module.syncingPool': 'Синхронизация данных пула с индексатором',
    'module.poolSynced': 'Данные пула синхронизированы с индексатором',
    'module.liquidity': 'Ликвидность',
    'module.noLps': 'Поставщиков ликвидности нет.',
    'module.reviewSwap': 'Проверить обмен Cauldron',
    'module.reviewWarnings': 'Проверьте предупреждения и сдвиньте ползунок.',
    'module.slideConfirm': 'Сдвиньте для подтверждения.',
    'module.pay': 'Оплата',
    'module.receive': 'Получение',
    'module.minimumReceive': 'Минимум к получению',
    'module.pools': 'Пулы',
    'module.poolBch': 'BCH пула',
    'module.poolToken': 'Токен пула',
    'module.withdrawBch': 'Вывести BCH',
    'module.withdrawToken': 'Вывести токен',
    'module.estimatedFee': 'Расчётная комиссия сети',
    'module.bchReserve': 'Резерв BCH',
    'module.feeApy': 'APY от комиссий',
  },
  'ha-NG': {
    'module.title': 'Cauldron',
    'module.flipDirection': 'Juya hanyar musayar',
    'module.syncingPool': 'Ana daidaita bayanan wurin daga indexer',
    'module.poolSynced': 'An daidaita bayanan wurin daga indexer',
    'module.liquidity': 'Liquidity',
    'module.noLps': 'Babu masu samar da liquidity.',
    'module.reviewSwap': 'Duba musayar Cauldron',
    'module.reviewWarnings': 'Duba gargadi sannan ka ja.',
    'module.slideConfirm': 'Ja don tabbatarwa.',
    'module.pay': 'Biya',
    'module.receive': 'Karɓa',
    'module.minimumReceive': 'Mafi ƙarancin karɓa',
    'module.pools': 'Wurare',
    'module.poolBch': 'BCH na wurin',
    'module.poolToken': 'Token na wurin',
    'module.withdrawBch': 'Cire BCH',
    'module.withdrawToken': 'Cire token',
    'module.estimatedFee': 'Kudin hanyar sadarwa da aka kiyasta',
    'module.bchReserve': 'Ajiyar BCH',
    'module.feeApy': 'APY bisa kuɗin caji',
  },
};

const extraMessages: AddonModuleLocaleMessages = {
  en: {
    'module.swap': 'Swap',
    'module.pool': 'Pool',
    'module.youPay': 'You pay',
    'module.max': 'Max',
    'module.walletBalance': 'Wallet: {balance}',
    'module.range': 'Range',
    'module.getQuote': 'Get quote',
    'module.aboveRange': 'Above current range.',
    'module.youReceive': 'You receive',
    'module.slippage': 'Slippage',
    'module.signing': 'Signing…',
    'module.loading': 'Loading…',
    'module.reviewQuote': 'Review swap',
    'module.slippageMinimum': 'Slippage sets the minimum.',
    'module.details': 'Details',
    'module.enterAmount': 'Enter an amount.',
    'module.owned': 'Owned',
    'module.market': 'Market',
    'module.working': 'Working…',
    'module.create': 'Create',
    'module.marketFilter': 'Market filter',
    'module.adjustedBalance': 'Adjusted to fit balance.',
    'module.enterBch': 'Enter BCH.',
    'module.enterToken': 'Enter {symbol}.',
    'module.bchExceedsBalance': 'BCH exceeds balance.',
    'module.tokenExceedsBalance': '{symbol} exceeds balance.',
    'module.readyToSign': 'Ready to sign.',
    'module.useRatio': 'Use ratio',
    'module.lps': 'LPs',
    'module.tvl': 'TVL',
    'module.autoFillTokenSide': 'Set BCH and {symbol} fills the token side.',
    'module.manualTokenInput': 'Use manual token input.',
    'module.swapExceedsBchCeiling':
      'Swap amount exceeds the current routable BCH ceiling.',
    'module.swapExceedsTokenCeiling':
      'Swap amount exceeds the current routable {symbol} ceiling.',
    'module.adjustedBalanceSuffix': ' Adjusted to fit balance.',
    'module.liquiditySlippageCheck': 'Liquidity & slippage check',
    'module.highSlippage': 'High for a wallet-confirmed swap.',
    'module.defaultSafety': 'Within the default safety threshold.',
    'module.marketDepthUsed': 'Market depth used',
    'module.marketDepthHigh':
      'This quote uses most of the currently executable market depth.',
    'module.marketDepthAvailable':
      'Leaves room for a cleaner unwind if the market stays steady.',
    'module.routePools': 'Route: {count} pools',
    'module.walletInputs': 'Wallet inputs: {count}',
    'module.requoteAdvice':
      'Re-quote if the market moves or if you want a tighter fill. The actual transaction is still re-validated before broadcast.',
    'module.warnings': 'Warnings',
    'module.reviewedWarnings':
      'I reviewed these warnings and still want to continue.',
    'module.route': 'Route',
    'module.quoteDetails': 'Quote details',
    'module.currentQuoteBreakdown': 'Current quote breakdown',
    'module.quotePreview': 'Quote preview.',
    'module.trade': 'Trade',
    'module.minReceive': 'Min receive',
    'module.priceImpact': 'Price impact',
    'module.fees': 'Fees',
    'module.lpFee': 'LP fee',
    'module.platformFee': 'Platform fee',
    'module.networkFee': 'Network fee',
    'module.minRoute': 'Min route',
    'module.maxBch': 'Max BCH',
    'module.maxToken': 'Max {symbol}',
    'module.reviewPoolCreation': 'Review pool creation',
    'module.reviewPoolWithdrawal': 'Review pool withdrawal',
    'module.lp': 'LP',
    'module.position': 'Position',
    'module.yield': 'Yield',
    'module.visibleWindowYield': 'Visible-window yield',
    'module.history': 'History',
    'module.activity': 'Activity',
    'module.noRecentActivity': 'No recent LP activity is available yet.',
    'module.lpPosition': 'LP position',
    'module.selectToken': 'Select token',
    'module.cauldronMarkets': 'Cauldron markets',
    'module.noTokens': 'No Cauldron tokens are available right now.',
    'module.noTokenMatches': 'No close token matches found.',
    'module.new': 'New',
    'module.syncingPoolPositions': 'Syncing pool positions from the indexer',
  },
  es: {
    'module.swap': 'Intercambio',
    'module.pool': 'Pool',
    'module.youPay': 'Pagas',
    'module.max': 'Máximo',
    'module.walletBalance': 'Cartera: {balance}',
    'module.range': 'Rango',
    'module.getQuote': 'Obtener cotización',
    'module.aboveRange': 'Por encima del rango actual.',
    'module.youReceive': 'Recibes',
    'module.slippage': 'Deslizamiento',
    'module.signing': 'Firmando…',
    'module.loading': 'Cargando…',
    'module.reviewQuote': 'Revisar intercambio',
    'module.slippageMinimum': 'El deslizamiento establece el mínimo.',
    'module.details': 'Detalles',
    'module.enterAmount': 'Introduce una cantidad.',
    'module.owned': 'Propios',
    'module.market': 'Mercado',
    'module.working': 'Procesando…',
    'module.create': 'Crear',
    'module.marketFilter': 'Filtro de mercado',
    'module.adjustedBalance': 'Ajustado al saldo.',
    'module.enterBch': 'Introduce BCH.',
    'module.enterToken': 'Introduce {symbol}.',
    'module.bchExceedsBalance': 'BCH supera el saldo.',
    'module.tokenExceedsBalance': '{symbol} supera el saldo.',
    'module.readyToSign': 'Listo para firmar.',
    'module.useRatio': 'Usar proporción',
    'module.lps': 'LP',
    'module.tvl': 'TVL',
    'module.autoFillTokenSide':
      'Establece BCH y {symbol} completa el lado del token.',
    'module.manualTokenInput': 'Introduce el token manualmente.',
    'module.swapExceedsBchCeiling':
      'La cantidad supera el límite de BCH enrutable.',
    'module.swapExceedsTokenCeiling':
      'La cantidad supera el límite enrutable de {symbol}.',
    'module.adjustedBalanceSuffix': ' Ajustado al saldo.',
    'module.liquiditySlippageCheck': 'Comprobación de liquidez y deslizamiento',
    'module.highSlippage':
      'Alto para un intercambio confirmado por la cartera.',
    'module.defaultSafety': 'Dentro del umbral de seguridad predeterminado.',
    'module.marketDepthUsed': 'Profundidad de mercado utilizada',
    'module.marketDepthHigh':
      'Esta cotización usa la mayor parte de la profundidad ejecutable actual.',
    'module.marketDepthAvailable':
      'Deja margen para deshacer la operación si el mercado se mantiene estable.',
    'module.routePools': 'Ruta: {count} pools',
    'module.walletInputs': 'Entradas de la cartera: {count}',
    'module.requoteAdvice':
      'Obtén otra cotización si cambia el mercado o quieres un precio más preciso. La transacción se vuelve a validar antes de difundirse.',
    'module.warnings': 'Advertencias',
    'module.reviewedWarnings':
      'He revisado estas advertencias y quiero continuar.',
    'module.route': 'Ruta',
    'module.quoteDetails': 'Detalles de la cotización',
    'module.currentQuoteBreakdown': 'Desglose de la cotización actual',
    'module.quotePreview': 'Vista previa de la cotización.',
    'module.trade': 'Operación',
    'module.minReceive': 'Mínimo a recibir',
    'module.priceImpact': 'Impacto en el precio',
    'module.fees': 'Comisiones',
    'module.lpFee': 'Comisión del LP',
    'module.platformFee': 'Comisión de la plataforma',
    'module.networkFee': 'Comisión de red',
    'module.minRoute': 'Ruta mínima',
    'module.maxBch': 'Máximo BCH',
    'module.maxToken': 'Máximo {symbol}',
    'module.reviewPoolCreation': 'Revisar creación del pool',
    'module.reviewPoolWithdrawal': 'Revisar retiro del pool',
    'module.lp': 'LP',
    'module.position': 'Posición',
    'module.yield': 'Rendimiento',
    'module.visibleWindowYield': 'Rendimiento visible',
    'module.history': 'Historial',
    'module.activity': 'Actividad',
    'module.noRecentActivity': 'Aún no hay actividad reciente del LP.',
    'module.lpPosition': 'Posición del LP',
    'module.selectToken': 'Seleccionar token',
    'module.cauldronMarkets': 'Mercados de Cauldron',
    'module.noTokens': 'No hay tokens de Cauldron disponibles.',
    'module.noTokenMatches': 'No se encontraron tokens similares.',
    'module.new': 'Nuevo',
    'module.syncingPoolPositions':
      'Sincronizando posiciones del pool desde el indexador',
  },
  'pt-BR': {
    'module.swap': 'Troca',
    'module.pool': 'Pool',
    'module.youPay': 'Você paga',
    'module.max': 'Máximo',
    'module.walletBalance': 'Carteira: {balance}',
    'module.range': 'Intervalo',
    'module.getQuote': 'Obter cotação',
    'module.aboveRange': 'Acima do intervalo atual.',
    'module.youReceive': 'Você recebe',
    'module.slippage': 'Deslizamento',
    'module.signing': 'Assinando…',
    'module.loading': 'Carregando…',
    'module.reviewQuote': 'Revisar troca',
    'module.slippageMinimum': 'O deslizamento define o mínimo.',
    'module.details': 'Detalhes',
    'module.enterAmount': 'Insira um valor.',
    'module.owned': 'Próprios',
    'module.market': 'Mercado',
    'module.working': 'Processando…',
    'module.create': 'Criar',
    'module.marketFilter': 'Filtro de mercado',
    'module.adjustedBalance': 'Ajustado ao saldo.',
    'module.enterBch': 'Insira BCH.',
    'module.enterToken': 'Insira {symbol}.',
    'module.bchExceedsBalance': 'BCH excede o saldo.',
    'module.tokenExceedsBalance': '{symbol} excede o saldo.',
    'module.readyToSign': 'Pronto para assinar.',
    'module.useRatio': 'Usar proporção',
    'module.lps': 'LPs',
    'module.tvl': 'TVL',
    'module.autoFillTokenSide':
      'Defina BCH e {symbol} preencherá o lado do token.',
    'module.manualTokenInput': 'Insira o token manualmente.',
    'module.swapExceedsBchCeiling': 'O valor excede o limite de BCH roteável.',
    'module.swapExceedsTokenCeiling':
      'O valor excede o limite roteável de {symbol}.',
    'module.adjustedBalanceSuffix': ' Ajustado ao saldo.',
    'module.liquiditySlippageCheck': 'Verificação de liquidez e deslizamento',
    'module.highSlippage': 'Alto para uma troca confirmada pela carteira.',
    'module.defaultSafety': 'Dentro do limite de segurança padrão.',
    'module.marketDepthUsed': 'Profundidade de mercado usada',
    'module.marketDepthHigh':
      'Esta cotação usa a maior parte da profundidade executável atual.',
    'module.marketDepthAvailable':
      'Deixa espaço para desfazer a operação se o mercado permanecer estável.',
    'module.routePools': 'Rota: {count} pools',
    'module.walletInputs': 'Entradas da carteira: {count}',
    'module.requoteAdvice':
      'Obtenha outra cotação se o mercado mudar ou se quiser um preenchimento mais preciso. A transação será validada novamente antes da transmissão.',
    'module.warnings': 'Avisos',
    'module.reviewedWarnings': 'Revisei estes avisos e ainda quero continuar.',
    'module.route': 'Rota',
    'module.quoteDetails': 'Detalhes da cotação',
    'module.currentQuoteBreakdown': 'Detalhamento da cotação atual',
    'module.quotePreview': 'Prévia da cotação.',
    'module.trade': 'Operação',
    'module.minReceive': 'Mínimo a receber',
    'module.priceImpact': 'Impacto no preço',
    'module.fees': 'Taxas',
    'module.lpFee': 'Taxa do LP',
    'module.platformFee': 'Taxa da plataforma',
    'module.networkFee': 'Taxa de rede',
    'module.minRoute': 'Rota mínima',
    'module.maxBch': 'Máximo de BCH',
    'module.maxToken': 'Máximo de {symbol}',
    'module.reviewPoolCreation': 'Revisar criação do pool',
    'module.reviewPoolWithdrawal': 'Revisar retirada do pool',
    'module.lp': 'LP',
    'module.position': 'Posição',
    'module.yield': 'Rendimento',
    'module.visibleWindowYield': 'Rendimento visível',
    'module.history': 'Histórico',
    'module.activity': 'Atividade',
    'module.noRecentActivity': 'Ainda não há atividade recente do LP.',
    'module.lpPosition': 'Posição do LP',
    'module.selectToken': 'Selecionar token',
    'module.cauldronMarkets': 'Mercados do Cauldron',
    'module.noTokens': 'Não há tokens do Cauldron disponíveis agora.',
    'module.noTokenMatches':
      'Nenhuma correspondência próxima de token foi encontrada.',
    'module.new': 'Novo',
    'module.syncingPoolPositions':
      'Sincronizando posições do pool pelo indexador',
  },
  'zh-CN': {
    'module.swap': '兑换',
    'module.pool': '池',
    'module.youPay': '你支付',
    'module.max': '最大',
    'module.walletBalance': '钱包：{balance}',
    'module.range': '范围',
    'module.getQuote': '获取报价',
    'module.aboveRange': '高于当前范围。',
    'module.youReceive': '你接收',
    'module.slippage': '滑点',
    'module.signing': '正在签名…',
    'module.loading': '正在加载…',
    'module.reviewQuote': '审核兑换',
    'module.slippageMinimum': '滑点决定最低接收量。',
    'module.details': '详情',
    'module.enterAmount': '输入金额。',
    'module.owned': '已拥有',
    'module.market': '市场',
    'module.working': '处理中…',
    'module.create': '创建',
    'module.marketFilter': '市场筛选',
    'module.adjustedBalance': '已调整以符合余额。',
    'module.enterBch': '输入 BCH。',
    'module.enterToken': '输入 {symbol}。',
    'module.bchExceedsBalance': 'BCH 超出余额。',
    'module.tokenExceedsBalance': '{symbol} 超出余额。',
    'module.readyToSign': '可以签名。',
    'module.useRatio': '使用比例',
    'module.lps': 'LP',
    'module.tvl': 'TVL',
    'module.autoFillTokenSide': '设置 BCH 后，{symbol} 会自动填充代币一侧。',
    'module.manualTokenInput': '手动输入代币数量。',
    'module.swapExceedsBchCeiling': '兑换金额超过当前可路由的 BCH 上限。',
    'module.swapExceedsTokenCeiling':
      '兑换金额超过当前可路由的 {symbol} 上限。',
    'module.adjustedBalanceSuffix': ' 已调整以符合余额。',
    'module.liquiditySlippageCheck': '流动性与滑点检查',
    'module.highSlippage': '对于钱包确认的兑换来说过高。',
    'module.defaultSafety': '在默认安全阈值内。',
    'module.marketDepthUsed': '已使用的市场深度',
    'module.marketDepthHigh': '此报价使用了大部分当前可执行的市场深度。',
    'module.marketDepthAvailable':
      '如果市场保持稳定，仍有空间进行更顺畅的反向交易。',
    'module.routePools': '路径：{count} 个池',
    'module.walletInputs': '钱包输入：{count}',
    'module.requoteAdvice':
      '如果市场变化或你希望获得更紧的成交价，请重新获取报价。广播前仍会重新验证交易。',
    'module.warnings': '警告',
    'module.reviewedWarnings': '我已查看这些警告，仍要继续。',
    'module.route': '路径',
    'module.quoteDetails': '报价详情',
    'module.currentQuoteBreakdown': '当前报价明细',
    'module.quotePreview': '报价预览。',
    'module.trade': '交易',
    'module.minReceive': '最低接收量',
    'module.priceImpact': '价格影响',
    'module.fees': '费用',
    'module.lpFee': 'LP 费用',
    'module.platformFee': '平台费用',
    'module.networkFee': '网络费',
    'module.minRoute': '最小路径',
    'module.maxBch': '最大 BCH',
    'module.maxToken': '最大 {symbol}',
    'module.reviewPoolCreation': '审核创建池',
    'module.reviewPoolWithdrawal': '审核提取池',
    'module.lp': 'LP',
    'module.position': '仓位',
    'module.yield': '收益',
    'module.visibleWindowYield': '可见区间收益',
    'module.history': '历史',
    'module.activity': '活动',
    'module.noRecentActivity': '目前没有最近的 LP 活动。',
    'module.lpPosition': 'LP 仓位',
    'module.selectToken': '选择代币',
    'module.cauldronMarkets': 'Cauldron 市场',
    'module.noTokens': '目前没有可用的 Cauldron 代币。',
    'module.noTokenMatches': '未找到相近的代币匹配。',
    'module.new': '新建',
    'module.syncingPoolPositions': '正在从索引器同步池仓位',
  },
  'zh-TW': {
    'module.swap': '兌換',
    'module.pool': '池',
    'module.youPay': '你支付',
    'module.max': '最大',
    'module.walletBalance': '錢包：{balance}',
    'module.range': '範圍',
    'module.getQuote': '取得報價',
    'module.aboveRange': '高於目前範圍。',
    'module.youReceive': '你接收',
    'module.slippage': '滑點',
    'module.signing': '正在簽名…',
    'module.loading': '正在載入…',
    'module.reviewQuote': '檢視兌換',
    'module.slippageMinimum': '滑點決定最低接收量。',
    'module.details': '詳細資料',
    'module.enterAmount': '輸入金額。',
    'module.owned': '已擁有',
    'module.market': '市場',
    'module.working': '處理中…',
    'module.create': '建立',
    'module.marketFilter': '市場篩選',
    'module.adjustedBalance': '已調整以符合餘額。',
    'module.enterBch': '輸入 BCH。',
    'module.enterToken': '輸入 {symbol}。',
    'module.bchExceedsBalance': 'BCH 超出餘額。',
    'module.tokenExceedsBalance': '{symbol} 超出餘額。',
    'module.readyToSign': '可以簽名。',
    'module.useRatio': '使用比例',
    'module.lps': 'LP',
    'module.tvl': 'TVL',
    'module.autoFillTokenSide': '設定 BCH 後，{symbol} 會自動填入代幣一側。',
    'module.manualTokenInput': '手動輸入代幣數量。',
    'module.swapExceedsBchCeiling': '兌換金額超過目前可路由的 BCH 上限。',
    'module.swapExceedsTokenCeiling':
      '兌換金額超過目前可路由的 {symbol} 上限。',
    'module.adjustedBalanceSuffix': ' 已調整以符合餘額。',
    'module.liquiditySlippageCheck': '流動性與滑點檢查',
    'module.highSlippage': '對錢包確認的兌換而言過高。',
    'module.defaultSafety': '在預設安全閾值內。',
    'module.marketDepthUsed': '已使用的市場深度',
    'module.marketDepthHigh': '此報價使用了大部分目前可執行的市場深度。',
    'module.marketDepthAvailable':
      '若市場保持穩定，仍有空間進行更順暢的反向交易。',
    'module.routePools': '路徑：{count} 個池',
    'module.walletInputs': '錢包輸入：{count}',
    'module.requoteAdvice':
      '若市場變化或你希望更精準成交，請重新取得報價。廣播前仍會重新驗證交易。',
    'module.warnings': '警告',
    'module.reviewedWarnings': '我已查看這些警告，仍要繼續。',
    'module.route': '路徑',
    'module.quoteDetails': '報價詳細資料',
    'module.currentQuoteBreakdown': '目前報價明細',
    'module.quotePreview': '報價預覽。',
    'module.trade': '交易',
    'module.minReceive': '最低接收量',
    'module.priceImpact': '價格影響',
    'module.fees': '費用',
    'module.lpFee': 'LP 費用',
    'module.platformFee': '平台費用',
    'module.networkFee': '網路費',
    'module.minRoute': '最小路徑',
    'module.maxBch': '最大 BCH',
    'module.maxToken': '最大 {symbol}',
    'module.reviewPoolCreation': '檢視建立池',
    'module.reviewPoolWithdrawal': '檢視提取池',
    'module.lp': 'LP',
    'module.position': '部位',
    'module.yield': '收益',
    'module.visibleWindowYield': '可見區間收益',
    'module.history': '歷史',
    'module.activity': '活動',
    'module.noRecentActivity': '目前沒有最近的 LP 活動。',
    'module.lpPosition': 'LP 部位',
    'module.selectToken': '選取代幣',
    'module.cauldronMarkets': 'Cauldron 市場',
    'module.noTokens': '目前沒有可用的 Cauldron 代幣。',
    'module.noTokenMatches': '找不到相近的代幣符合項目。',
    'module.new': '新增',
    'module.syncingPoolPositions': '正在從索引器同步池部位',
  },
  vi: {
    'module.swap': 'Hoán đổi',
    'module.pool': 'Pool',
    'module.youPay': 'Bạn trả',
    'module.max': 'Tối đa',
    'module.walletBalance': 'Ví: {balance}',
    'module.range': 'Phạm vi',
    'module.getQuote': 'Lấy báo giá',
    'module.aboveRange': 'Vượt phạm vi hiện tại.',
    'module.youReceive': 'Bạn nhận',
    'module.slippage': 'Trượt giá',
    'module.signing': 'Đang ký…',
    'module.loading': 'Đang tải…',
    'module.reviewQuote': 'Xem lại hoán đổi',
    'module.slippageMinimum': 'Trượt giá đặt mức nhận tối thiểu.',
    'module.details': 'Chi tiết',
    'module.enterAmount': 'Nhập số tiền.',
    'module.owned': 'Đang sở hữu',
    'module.market': 'Thị trường',
    'module.working': 'Đang xử lý…',
    'module.create': 'Tạo',
    'module.marketFilter': 'Bộ lọc thị trường',
    'module.adjustedBalance': 'Đã điều chỉnh theo số dư.',
    'module.enterBch': 'Nhập BCH.',
    'module.enterToken': 'Nhập {symbol}.',
    'module.bchExceedsBalance': 'BCH vượt số dư.',
    'module.tokenExceedsBalance': '{symbol} vượt số dư.',
    'module.readyToSign': 'Sẵn sàng ký.',
    'module.useRatio': 'Dùng tỷ lệ',
    'module.lps': 'LP',
    'module.tvl': 'TVL',
    'module.autoFillTokenSide': 'Đặt BCH để tự điền phía token {symbol}.',
    'module.manualTokenInput': 'Nhập token thủ công.',
    'module.swapExceedsBchCeiling':
      'Số tiền hoán đổi vượt giới hạn BCH có thể định tuyến.',
    'module.swapExceedsTokenCeiling':
      'Số tiền hoán đổi vượt giới hạn {symbol} có thể định tuyến.',
    'module.adjustedBalanceSuffix': ' Đã điều chỉnh theo số dư.',
    'module.liquiditySlippageCheck': 'Kiểm tra thanh khoản và trượt giá',
    'module.highSlippage': 'Cao đối với giao dịch được ví xác nhận.',
    'module.defaultSafety': 'Trong ngưỡng an toàn mặc định.',
    'module.marketDepthUsed': 'Độ sâu thị trường đã dùng',
    'module.marketDepthHigh':
      'Báo giá này dùng phần lớn độ sâu thị trường hiện có thể thực thi.',
    'module.marketDepthAvailable':
      'Vẫn còn khoảng trống để đảo giao dịch nếu thị trường ổn định.',
    'module.routePools': 'Tuyến: {count} pool',
    'module.walletInputs': 'Đầu vào ví: {count}',
    'module.requoteAdvice':
      'Lấy báo giá mới nếu thị trường thay đổi hoặc bạn muốn khớp chặt hơn. Giao dịch vẫn được xác minh lại trước khi phát sóng.',
    'module.warnings': 'Cảnh báo',
    'module.reviewedWarnings':
      'Tôi đã xem các cảnh báo này và vẫn muốn tiếp tục.',
    'module.route': 'Tuyến',
    'module.quoteDetails': 'Chi tiết báo giá',
    'module.currentQuoteBreakdown': 'Phân tích báo giá hiện tại',
    'module.quotePreview': 'Xem trước báo giá.',
    'module.trade': 'Giao dịch',
    'module.minReceive': 'Mức nhận tối thiểu',
    'module.priceImpact': 'Ảnh hưởng giá',
    'module.fees': 'Phí',
    'module.lpFee': 'Phí LP',
    'module.platformFee': 'Phí nền tảng',
    'module.networkFee': 'Phí mạng',
    'module.minRoute': 'Tuyến tối thiểu',
    'module.maxBch': 'BCH tối đa',
    'module.maxToken': '{symbol} tối đa',
    'module.reviewPoolCreation': 'Xem lại việc tạo pool',
    'module.reviewPoolWithdrawal': 'Xem lại việc rút pool',
    'module.lp': 'LP',
    'module.position': 'Vị thế',
    'module.yield': 'Lợi suất',
    'module.visibleWindowYield': 'Lợi suất trong khoảng hiển thị',
    'module.history': 'Lịch sử',
    'module.activity': 'Hoạt động',
    'module.noRecentActivity': 'Chưa có hoạt động LP gần đây.',
    'module.lpPosition': 'Vị thế LP',
    'module.selectToken': 'Chọn token',
    'module.cauldronMarkets': 'Thị trường Cauldron',
    'module.noTokens': 'Hiện không có token Cauldron.',
    'module.noTokenMatches': 'Không tìm thấy token phù hợp.',
    'module.new': 'Mới',
    'module.syncingPoolPositions': 'Đang đồng bộ vị thế pool từ bộ lập chỉ mục',
  },
  ar: {
    'module.swap': 'مبادلة',
    'module.pool': 'المجمع',
    'module.youPay': 'تدفع',
    'module.max': 'الحد الأقصى',
    'module.walletBalance': 'المحفظة: {balance}',
    'module.range': 'النطاق',
    'module.getQuote': 'الحصول على عرض',
    'module.aboveRange': 'أعلى من النطاق الحالي.',
    'module.youReceive': 'تستلم',
    'module.slippage': 'الانزلاق',
    'module.signing': 'جارٍ التوقيع…',
    'module.loading': 'جارٍ التحميل…',
    'module.reviewQuote': 'مراجعة المبادلة',
    'module.slippageMinimum': 'يحدد الانزلاق الحد الأدنى للاستلام.',
    'module.details': 'التفاصيل',
    'module.enterAmount': 'أدخل المبلغ.',
    'module.owned': 'مملوك',
    'module.market': 'السوق',
    'module.working': 'جارٍ العمل…',
    'module.create': 'إنشاء',
    'module.marketFilter': 'تصفية السوق',
    'module.adjustedBalance': 'تمت المطابقة مع الرصيد.',
    'module.enterBch': 'أدخل BCH.',
    'module.enterToken': 'أدخل {symbol}.',
    'module.bchExceedsBalance': 'يتجاوز BCH الرصيد.',
    'module.tokenExceedsBalance': 'يتجاوز {symbol} الرصيد.',
    'module.readyToSign': 'جاهز للتوقيع.',
    'module.useRatio': 'استخدام النسبة',
    'module.lps': 'LP',
    'module.tvl': 'TVL',
    'module.autoFillTokenSide': 'اضبط BCH لملء جانب الرمز {symbol}.',
    'module.manualTokenInput': 'أدخل الرمز يدويًا.',
    'module.swapExceedsBchCeiling':
      'يتجاوز مبلغ المبادلة الحد القابل للتوجيه من BCH.',
    'module.swapExceedsTokenCeiling':
      'يتجاوز مبلغ المبادلة الحد القابل للتوجيه من {symbol}.',
    'module.adjustedBalanceSuffix': ' تمت المطابقة مع الرصيد.',
    'module.liquiditySlippageCheck': 'فحص السيولة والانزلاق',
    'module.highSlippage': 'مرتفع بالنسبة لمبادلة يؤكدها المحفظة.',
    'module.defaultSafety': 'ضمن حد الأمان الافتراضي.',
    'module.marketDepthUsed': 'عمق السوق المستخدم',
    'module.marketDepthHigh':
      'يستخدم هذا العرض معظم عمق السوق القابل للتنفيذ حاليًا.',
    'module.marketDepthAvailable':
      'يبقى مجال لعكس العملية بسلاسة أكبر إذا استقر السوق.',
    'module.routePools': 'المسار: {count} مجمعات',
    'module.walletInputs': 'مدخلات المحفظة: {count}',
    'module.requoteAdvice':
      'احصل على عرض جديد إذا تحرك السوق أو أردت سعرًا أدق. ستُعاد مصادقة المعاملة قبل بثها.',
    'module.warnings': 'تحذيرات',
    'module.reviewedWarnings': 'راجعت هذه التحذيرات وما زلت أريد المتابعة.',
    'module.route': 'المسار',
    'module.quoteDetails': 'تفاصيل العرض',
    'module.currentQuoteBreakdown': 'تفصيل العرض الحالي',
    'module.quotePreview': 'معاينة العرض.',
    'module.trade': 'التداول',
    'module.minReceive': 'الحد الأدنى للاستلام',
    'module.priceImpact': 'تأثير السعر',
    'module.fees': 'الرسوم',
    'module.lpFee': 'رسوم LP',
    'module.platformFee': 'رسوم المنصة',
    'module.networkFee': 'رسوم الشبكة',
    'module.minRoute': 'الحد الأدنى للمسار',
    'module.maxBch': 'الحد الأقصى من BCH',
    'module.maxToken': 'الحد الأقصى من {symbol}',
    'module.reviewPoolCreation': 'مراجعة إنشاء المجمع',
    'module.reviewPoolWithdrawal': 'مراجعة سحب المجمع',
    'module.lp': 'LP',
    'module.position': 'المركز',
    'module.yield': 'العائد',
    'module.visibleWindowYield': 'العائد في النافذة المرئية',
    'module.history': 'السجل',
    'module.activity': 'النشاط',
    'module.noRecentActivity': 'لا يوجد نشاط حديث لـ LP بعد.',
    'module.lpPosition': 'مركز LP',
    'module.selectToken': 'اختيار الرمز',
    'module.cauldronMarkets': 'أسواق Cauldron',
    'module.noTokens': 'لا توجد رموز Cauldron متاحة حاليًا.',
    'module.noTokenMatches': 'لم يتم العثور على رموز مشابهة.',
    'module.new': 'جديد',
    'module.syncingPoolPositions': 'جارٍ مزامنة مراكز المجمع من المفهرس',
  },
  fr: {
    'module.swap': 'Échanger',
    'module.pool': 'Pool',
    'module.youPay': 'Vous payez',
    'module.max': 'Max',
    'module.walletBalance': 'Portefeuille : {balance}',
    'module.range': 'Plage',
    'module.getQuote': 'Obtenir un devis',
    'module.aboveRange': 'Au-dessus de la plage actuelle.',
    'module.youReceive': 'Vous recevez',
    'module.slippage': 'Glissement',
    'module.signing': 'Signature…',
    'module.loading': 'Chargement…',
    'module.reviewQuote': 'Vérifier l’échange',
    'module.slippageMinimum': 'Le glissement définit le minimum.',
    'module.details': 'Détails',
    'module.enterAmount': 'Saisissez un montant.',
    'module.owned': 'Détenus',
    'module.market': 'Marché',
    'module.working': 'Traitement…',
    'module.create': 'Créer',
    'module.marketFilter': 'Filtre du marché',
    'module.adjustedBalance': 'Ajusté selon le solde.',
    'module.enterBch': 'Saisissez des BCH.',
    'module.enterToken': 'Saisissez {symbol}.',
    'module.bchExceedsBalance': 'Les BCH dépassent le solde.',
    'module.tokenExceedsBalance': '{symbol} dépasse le solde.',
    'module.readyToSign': 'Prêt à signer.',
    'module.useRatio': 'Utiliser le ratio',
    'module.lps': 'LP',
    'module.tvl': 'TVL',
    'module.autoFillTokenSide':
      'Définissez les BCH pour remplir le côté {symbol}.',
    'module.manualTokenInput': 'Saisissez le token manuellement.',
    'module.swapExceedsBchCeiling':
      'Le montant dépasse le plafond de BCH acheminable.',
    'module.swapExceedsTokenCeiling':
      'Le montant dépasse le plafond acheminable de {symbol}.',
    'module.adjustedBalanceSuffix': ' Ajusté selon le solde.',
    'module.liquiditySlippageCheck':
      'Vérification de la liquidité et du glissement',
    'module.highSlippage':
      'Élevé pour un échange confirmé par le portefeuille.',
    'module.defaultSafety': 'Dans le seuil de sécurité par défaut.',
    'module.marketDepthUsed': 'Profondeur de marché utilisée',
    'module.marketDepthHigh':
      'Ce devis utilise la majeure partie de la profondeur de marché actuellement exécutable.',
    'module.marketDepthAvailable':
      'Il reste de la marge pour un retour plus propre si le marché reste stable.',
    'module.routePools': 'Route : {count} pools',
    'module.walletInputs': 'Entrées du portefeuille : {count}',
    'module.requoteAdvice':
      'Obtenez un nouveau devis si le marché bouge ou si vous voulez un meilleur prix. La transaction sera de nouveau validée avant sa diffusion.',
    'module.warnings': 'Avertissements',
    'module.reviewedWarnings':
      'J’ai lu ces avertissements et je souhaite continuer.',
    'module.route': 'Route',
    'module.quoteDetails': 'Détails du devis',
    'module.currentQuoteBreakdown': 'Détail du devis actuel',
    'module.quotePreview': 'Aperçu du devis.',
    'module.trade': 'Échange',
    'module.minReceive': 'Minimum reçu',
    'module.priceImpact': 'Impact sur le prix',
    'module.fees': 'Frais',
    'module.lpFee': 'Frais du LP',
    'module.platformFee': 'Frais de la plateforme',
    'module.networkFee': 'Frais réseau',
    'module.minRoute': 'Route minimale',
    'module.maxBch': 'BCH maximum',
    'module.maxToken': '{symbol} maximum',
    'module.reviewPoolCreation': 'Vérifier la création du pool',
    'module.reviewPoolWithdrawal': 'Vérifier le retrait du pool',
    'module.lp': 'LP',
    'module.position': 'Position',
    'module.yield': 'Rendement',
    'module.visibleWindowYield': 'Rendement visible',
    'module.history': 'Historique',
    'module.activity': 'Activité',
    'module.noRecentActivity': 'Aucune activité LP récente pour le moment.',
    'module.lpPosition': 'Position LP',
    'module.selectToken': 'Sélectionner un token',
    'module.cauldronMarkets': 'Marchés Cauldron',
    'module.noTokens': 'Aucun token Cauldron disponible pour le moment.',
    'module.noTokenMatches': 'Aucun token proche trouvé.',
    'module.new': 'Nouveau',
    'module.syncingPoolPositions':
      'Synchronisation des positions du pool depuis l’indexeur',
  },
  ko: {
    'module.swap': '교환',
    'module.pool': '풀',
    'module.youPay': '지불',
    'module.max': '최대',
    'module.walletBalance': '지갑: {balance}',
    'module.range': '범위',
    'module.getQuote': '견적 받기',
    'module.aboveRange': '현재 범위를 초과했습니다.',
    'module.youReceive': '수령',
    'module.slippage': '슬리피지',
    'module.signing': '서명 중…',
    'module.loading': '로드 중…',
    'module.reviewQuote': '교환 검토',
    'module.slippageMinimum': '슬리피지가 최소 수령량을 정합니다.',
    'module.details': '세부 정보',
    'module.enterAmount': '금액을 입력하세요.',
    'module.owned': '보유',
    'module.market': '시장',
    'module.working': '처리 중…',
    'module.create': '생성',
    'module.marketFilter': '시장 필터',
    'module.adjustedBalance': '잔액에 맞게 조정됨.',
    'module.enterBch': 'BCH를 입력하세요.',
    'module.enterToken': '{symbol}을(를) 입력하세요.',
    'module.bchExceedsBalance': 'BCH가 잔액을 초과합니다.',
    'module.tokenExceedsBalance': '{symbol}이(가) 잔액을 초과합니다.',
    'module.readyToSign': '서명할 준비가 되었습니다.',
    'module.useRatio': '비율 사용',
    'module.lps': 'LP',
    'module.tvl': 'TVL',
    'module.autoFillTokenSide':
      'BCH를 설정하면 {symbol} 토큰 쪽이 자동으로 채워집니다.',
    'module.manualTokenInput': '토큰 수량을 직접 입력하세요.',
    'module.swapExceedsBchCeiling':
      '교환 금액이 현재 라우팅 가능한 BCH 한도를 초과합니다.',
    'module.swapExceedsTokenCeiling':
      '교환 금액이 현재 라우팅 가능한 {symbol} 한도를 초과합니다.',
    'module.adjustedBalanceSuffix': ' 잔액에 맞게 조정됨.',
    'module.liquiditySlippageCheck': '유동성 및 슬리피지 확인',
    'module.highSlippage': '지갑 확인 교환에 비해 높습니다.',
    'module.defaultSafety': '기본 안전 한도 내에 있습니다.',
    'module.marketDepthUsed': '사용한 시장 깊이',
    'module.marketDepthHigh':
      '이 견적은 현재 실행 가능한 시장 깊이 대부분을 사용합니다.',
    'module.marketDepthAvailable':
      '시장이 안정적이면 더 원활한 반대 거래를 위한 여유가 있습니다.',
    'module.routePools': '경로: 풀 {count}개',
    'module.walletInputs': '지갑 입력: {count}',
    'module.requoteAdvice':
      '시장이 변하거나 더 정확한 체결을 원하면 견적을 다시 받으세요. 브로드캐스트 전에 거래가 다시 검증됩니다.',
    'module.warnings': '경고',
    'module.reviewedWarnings': '경고를 확인했으며 계속 진행하겠습니다.',
    'module.route': '경로',
    'module.quoteDetails': '견적 세부 정보',
    'module.currentQuoteBreakdown': '현재 견적 내역',
    'module.quotePreview': '견적 미리보기.',
    'module.trade': '거래',
    'module.minReceive': '최소 수령량',
    'module.priceImpact': '가격 영향',
    'module.fees': '수수료',
    'module.lpFee': 'LP 수수료',
    'module.platformFee': '플랫폼 수수료',
    'module.networkFee': '네트워크 수수료',
    'module.minRoute': '최소 경로',
    'module.maxBch': '최대 BCH',
    'module.maxToken': '최대 {symbol}',
    'module.reviewPoolCreation': '풀 생성 검토',
    'module.reviewPoolWithdrawal': '풀 출금 검토',
    'module.lp': 'LP',
    'module.position': '포지션',
    'module.yield': '수익률',
    'module.visibleWindowYield': '표시 구간 수익률',
    'module.history': '기록',
    'module.activity': '활동',
    'module.noRecentActivity': '최근 LP 활동이 아직 없습니다.',
    'module.lpPosition': 'LP 포지션',
    'module.selectToken': '토큰 선택',
    'module.cauldronMarkets': 'Cauldron 시장',
    'module.noTokens': '현재 사용 가능한 Cauldron 토큰이 없습니다.',
    'module.noTokenMatches': '일치하는 토큰을 찾을 수 없습니다.',
    'module.new': '새로 만들기',
    'module.syncingPoolPositions': '인덱서에서 풀 포지션을 동기화하는 중',
  },
  ja: {
    'module.swap': '交換',
    'module.pool': 'プール',
    'module.youPay': '支払う',
    'module.max': '最大',
    'module.walletBalance': 'ウォレット：{balance}',
    'module.range': '範囲',
    'module.getQuote': '見積もりを取得',
    'module.aboveRange': '現在の範囲を超えています。',
    'module.youReceive': '受け取る',
    'module.slippage': 'スリッページ',
    'module.signing': '署名中…',
    'module.loading': '読み込み中…',
    'module.reviewQuote': '交換を確認',
    'module.slippageMinimum': 'スリッページが最小受取量を決めます。',
    'module.details': '詳細',
    'module.enterAmount': '金額を入力してください。',
    'module.owned': '保有',
    'module.market': '市場',
    'module.working': '処理中…',
    'module.create': '作成',
    'module.marketFilter': '市場フィルター',
    'module.adjustedBalance': '残高に合わせて調整しました。',
    'module.enterBch': 'BCHを入力してください。',
    'module.enterToken': '{symbol}を入力してください。',
    'module.bchExceedsBalance': 'BCHが残高を超えています。',
    'module.tokenExceedsBalance': '{symbol}が残高を超えています。',
    'module.readyToSign': '署名の準備ができました。',
    'module.useRatio': '比率を使用',
    'module.lps': 'LP',
    'module.tvl': 'TVL',
    'module.autoFillTokenSide':
      'BCHを設定すると、{symbol}側が自動入力されます。',
    'module.manualTokenInput': 'トークン数量を手動で入力してください。',
    'module.swapExceedsBchCeiling':
      '交換額が現在ルーティング可能なBCH上限を超えています。',
    'module.swapExceedsTokenCeiling':
      '交換額が現在ルーティング可能な{symbol}上限を超えています。',
    'module.adjustedBalanceSuffix': ' 残高に合わせて調整しました。',
    'module.liquiditySlippageCheck': '流動性とスリッページの確認',
    'module.highSlippage': 'ウォレット確認の交換としては高い値です。',
    'module.defaultSafety': '既定の安全しきい値内です。',
    'module.marketDepthUsed': '使用した市場の深さ',
    'module.marketDepthHigh':
      'この見積もりは現在実行可能な市場の深さの大部分を使用します。',
    'module.marketDepthAvailable':
      '市場が安定していれば、より滑らかな反対取引の余地があります。',
    'module.routePools': 'ルート：{count}個のプール',
    'module.walletInputs': 'ウォレット入力：{count}',
    'module.requoteAdvice':
      '市場が動いた場合や、より厳密な約定を望む場合は見積もりを取り直してください。ブロードキャスト前に取引を再検証します。',
    'module.warnings': '警告',
    'module.reviewedWarnings': '警告を確認し、続行します。',
    'module.route': 'ルート',
    'module.quoteDetails': '見積もりの詳細',
    'module.currentQuoteBreakdown': '現在の見積もり内訳',
    'module.quotePreview': '見積もりプレビュー。',
    'module.trade': '取引',
    'module.minReceive': '最小受取量',
    'module.priceImpact': '価格への影響',
    'module.fees': '手数料',
    'module.lpFee': 'LP手数料',
    'module.platformFee': 'プラットフォーム手数料',
    'module.networkFee': 'ネットワーク手数料',
    'module.minRoute': '最小ルート',
    'module.maxBch': '最大BCH',
    'module.maxToken': '最大{symbol}',
    'module.reviewPoolCreation': 'プール作成を確認',
    'module.reviewPoolWithdrawal': 'プール引き出しを確認',
    'module.lp': 'LP',
    'module.position': 'ポジション',
    'module.yield': '利回り',
    'module.visibleWindowYield': '表示範囲の利回り',
    'module.history': '履歴',
    'module.activity': 'アクティビティ',
    'module.noRecentActivity': '最近のLPアクティビティはまだありません。',
    'module.lpPosition': 'LPポジション',
    'module.selectToken': 'トークンを選択',
    'module.cauldronMarkets': 'Cauldron市場',
    'module.noTokens': '現在利用できるCauldronトークンはありません。',
    'module.noTokenMatches': '近いトークンは見つかりませんでした。',
    'module.new': '新規',
    'module.syncingPoolPositions': 'インデクサーからプールポジションを同期中',
  },
  ru: {
    'module.swap': 'Обмен',
    'module.pool': 'Пул',
    'module.youPay': 'Вы платите',
    'module.max': 'Макс.',
    'module.walletBalance': 'Кошелёк: {balance}',
    'module.range': 'Диапазон',
    'module.getQuote': 'Получить котировку',
    'module.aboveRange': 'Выше текущего диапазона.',
    'module.youReceive': 'Вы получаете',
    'module.slippage': 'Проскальзывание',
    'module.signing': 'Подписание…',
    'module.loading': 'Загрузка…',
    'module.reviewQuote': 'Проверить обмен',
    'module.slippageMinimum': 'Проскальзывание задаёт минимум.',
    'module.details': 'Сведения',
    'module.enterAmount': 'Введите сумму.',
    'module.owned': 'Мои',
    'module.market': 'Рынок',
    'module.working': 'Обработка…',
    'module.create': 'Создать',
    'module.marketFilter': 'Фильтр рынка',
    'module.adjustedBalance': 'Скорректировано по балансу.',
    'module.enterBch': 'Введите BCH.',
    'module.enterToken': 'Введите {symbol}.',
    'module.bchExceedsBalance': 'Сумма BCH превышает баланс.',
    'module.tokenExceedsBalance': '{symbol} превышает баланс.',
    'module.readyToSign': 'Готово к подписанию.',
    'module.useRatio': 'Использовать соотношение',
    'module.lps': 'LP',
    'module.tvl': 'TVL',
    'module.autoFillTokenSide':
      'Задайте BCH, чтобы заполнить сторону токена {symbol}.',
    'module.manualTokenInput': 'Введите токен вручную.',
    'module.swapExceedsBchCeiling':
      'Сумма обмена превышает доступный для маршрутизации предел BCH.',
    'module.swapExceedsTokenCeiling':
      'Сумма обмена превышает доступный для маршрутизации предел {symbol}.',
    'module.adjustedBalanceSuffix': ' Скорректировано по балансу.',
    'module.liquiditySlippageCheck': 'Проверка ликвидности и проскальзывания',
    'module.highSlippage':
      'Высокое значение для обмена с подтверждением кошелька.',
    'module.defaultSafety': 'В пределах стандартного порога безопасности.',
    'module.marketDepthUsed': 'Использованная глубина рынка',
    'module.marketDepthHigh':
      'Эта котировка использует большую часть доступной глубины рынка.',
    'module.marketDepthAvailable':
      'При стабильном рынке останется место для более плавного обратного обмена.',
    'module.routePools': 'Маршрут: пулов — {count}',
    'module.walletInputs': 'Входы кошелька: {count}',
    'module.requoteAdvice':
      'Получите новую котировку при движении рынка или для более точного исполнения. Перед трансляцией транзакция будет проверена снова.',
    'module.warnings': 'Предупреждения',
    'module.reviewedWarnings':
      'Я ознакомился с предупреждениями и хочу продолжить.',
    'module.route': 'Маршрут',
    'module.quoteDetails': 'Сведения о котировке',
    'module.currentQuoteBreakdown': 'Разбор текущей котировки',
    'module.quotePreview': 'Предпросмотр котировки.',
    'module.trade': 'Обмен',
    'module.minReceive': 'Минимум к получению',
    'module.priceImpact': 'Влияние на цену',
    'module.fees': 'Комиссии',
    'module.lpFee': 'Комиссия LP',
    'module.platformFee': 'Комиссия платформы',
    'module.networkFee': 'Комиссия сети',
    'module.minRoute': 'Минимальный маршрут',
    'module.maxBch': 'Максимум BCH',
    'module.maxToken': 'Максимум {symbol}',
    'module.reviewPoolCreation': 'Проверить создание пула',
    'module.reviewPoolWithdrawal': 'Проверить вывод из пула',
    'module.lp': 'LP',
    'module.position': 'Позиция',
    'module.yield': 'Доходность',
    'module.visibleWindowYield': 'Доходность видимого периода',
    'module.history': 'История',
    'module.activity': 'Активность',
    'module.noRecentActivity': 'Недавней активности LP пока нет.',
    'module.lpPosition': 'Позиция LP',
    'module.selectToken': 'Выбрать токен',
    'module.cauldronMarkets': 'Рынки Cauldron',
    'module.noTokens': 'Доступных токенов Cauldron сейчас нет.',
    'module.noTokenMatches': 'Подходящие токены не найдены.',
    'module.new': 'Новый',
    'module.syncingPoolPositions': 'Синхронизация позиций пула с индексатором',
  },
  'ha-NG': {
    'module.swap': 'Musaya',
    'module.pool': 'Wurin',
    'module.youPay': 'Kana biya',
    'module.max': 'Mafi yawa',
    'module.walletBalance': 'Walat: {balance}',
    'module.range': 'Iyakar',
    'module.getQuote': 'Samo ƙididdiga',
    'module.aboveRange': 'Ya wuce iyakar yanzu.',
    'module.youReceive': 'Kana karɓa',
    'module.slippage': 'Zamewa',
    'module.signing': 'Ana sa hannu…',
    'module.loading': 'Ana lodawa…',
    'module.reviewQuote': 'Duba musayar',
    'module.slippageMinimum': 'Zamewa yana saita mafi ƙarancin karɓa.',
    'module.details': 'Cikakkun bayanai',
    'module.enterAmount': 'Shigar da adadi.',
    'module.owned': 'Mallaka',
    'module.market': 'Kasuwa',
    'module.working': 'Ana aiki…',
    'module.create': 'Ƙirƙira',
    'module.marketFilter': 'Tace kasuwa',
    'module.adjustedBalance': 'An daidaita da ma’auni.',
    'module.enterBch': 'Shigar da BCH.',
    'module.enterToken': 'Shigar da {symbol}.',
    'module.bchExceedsBalance': 'BCH ya wuce ma’auni.',
    'module.tokenExceedsBalance': '{symbol} ya wuce ma’auni.',
    'module.readyToSign': 'A shirye don sa hannu.',
    'module.useRatio': 'Yi amfani da rabo',
    'module.lps': 'LP',
    'module.tvl': 'TVL',
    'module.autoFillTokenSide':
      'Saita BCH don cike ɓangaren token na {symbol}.',
    'module.manualTokenInput': 'Shigar da token da hannu.',
    'module.swapExceedsBchCeiling':
      'Adadin musayar ya wuce iyakar BCH da ake iya bi ta hanya.',
    'module.swapExceedsTokenCeiling':
      'Adadin musayar ya wuce iyakar {symbol} da ake iya bi ta hanya.',
    'module.adjustedBalanceSuffix': ' An daidaita da ma’auni.',
    'module.liquiditySlippageCheck': 'Duba liquidity da zamewa',
    'module.highSlippage': 'Ya yi yawa ga musayar da walat ya tabbatar.',
    'module.defaultSafety': 'Yana cikin iyakar tsaro ta asali.',
    'module.marketDepthUsed': 'Zurfin kasuwa da aka yi amfani da shi',
    'module.marketDepthHigh':
      'Wannan ƙididdiga tana amfani da yawancin zurfin kasuwar da ake iya aiwatarwa yanzu.',
    'module.marketDepthAvailable':
      'Akwai sarari don komawa cikin sauƙi idan kasuwa ta tsaya.',
    'module.routePools': 'Hanya: wurare {count}',
    'module.walletInputs': 'Abubuwan shigar walat: {count}',
    'module.requoteAdvice':
      'Sake samun ƙididdiga idan kasuwa ta motsa ko kana son cikawa mafi kusa. Za a sake tabbatar da ma’amala kafin watsawa.',
    'module.warnings': 'Gargadi',
    'module.reviewedWarnings':
      'Na duba waɗannan gargadi kuma har yanzu ina son ci gaba.',
    'module.route': 'Hanya',
    'module.quoteDetails': 'Cikakkun ƙididdigar',
    'module.currentQuoteBreakdown': 'Rarrabawar ƙididdigar yanzu',
    'module.quotePreview': 'Dubawar ƙididdiga.',
    'module.trade': 'Ciniki',
    'module.minReceive': 'Mafi ƙarancin karɓa',
    'module.priceImpact': 'Tasirin farashi',
    'module.fees': 'Kuɗaɗe',
    'module.lpFee': 'Kuɗin LP',
    'module.platformFee': 'Kuɗin dandamali',
    'module.networkFee': 'Kuɗin hanyar sadarwa',
    'module.minRoute': 'Mafi ƙarancin hanya',
    'module.maxBch': 'Mafi yawan BCH',
    'module.maxToken': 'Mafi yawan {symbol}',
    'module.reviewPoolCreation': 'Duba ƙirƙirar wurin',
    'module.reviewPoolWithdrawal': 'Duba cirewa daga wurin',
    'module.lp': 'LP',
    'module.position': 'Matsayi',
    'module.yield': 'Riba',
    'module.visibleWindowYield': 'Ribar lokacin da ake gani',
    'module.history': 'Tarihi',
    'module.activity': 'Aiki',
    'module.noRecentActivity': 'Babu aikin LP na baya-bayan nan tukuna.',
    'module.lpPosition': 'Matsayin LP',
    'module.selectToken': 'Zaɓi token',
    'module.cauldronMarkets': 'Kasuwannin Cauldron',
    'module.noTokens': 'Babu token na Cauldron da ke samuwa yanzu.',
    'module.noTokenMatches': 'Ba a sami token mai kama ba.',
    'module.new': 'Sabo',
    'module.syncingPoolPositions': 'Ana daidaita matsayin wurin daga indexer',
  },
};

const statusMessages: AddonModuleLocaleMessages = {
  en: {
    'module.errorLoadMarkets': 'Failed to load Cauldron markets',
    'module.errorLoadPools': 'Failed to load Cauldron pools',
    'module.marketRatio':
      'Market ratio: {tokenAmount} {symbol} for {bchAmount} BCH.{adjustment}',
    'module.lpRefreshFailed': 'LP refresh failed. Showing cached pools.',
    'module.liveUpdateReceived':
      'Live Cauldron pool update received. Refresh the quote before swapping.',
    'module.poolBchExceedsBalance':
      'Pool BCH amount exceeds your spendable BCH balance after the network fee buffer.',
    'module.poolTokenExceedsBalance':
      'Pool {symbol} amount exceeds your available token balance.',
    'module.pickToken': 'Pick a Cauldron token first.',
    'module.validAmount': 'Enter a valid amount greater than zero.',
    'module.noActivePools':
      'No active Cauldron pools were found for this token.',
    'module.minimumRouteAmount':
      'That amount is below the current minimum routable market size. The market currently needs at least {amount} to build an executable route.',
    'module.marketChanged':
      'The visible Cauldron market changed on chain before this quote could be built. Refresh and try again.',
    'module.noQuoteAvailable':
      'No Cauldron quote is currently available for that amount.',
    'module.noExecutableRoute':
      'Cauldron could not build a route with any executable pools for this direction. Refresh and try again.',
    'module.noSettlementAddress': 'No wallet settlement address is available.',
    'module.routeComplex':
      'This route uses {count} pools, which is more complex than a typical swap.',
    'module.walletInputsWarning':
      'This swap will spend {count} wallet inputs. Review the selected coins carefully.',
    'module.slippageWarning':
      'Your slippage setting is {percent}%, which is high for a wallet-confirmed swap.',
    'module.feeWarning':
      'Estimated network fee is relatively high for this trade size ({percent}%).',
    'module.liquidityUsageWarning':
      '{label} is using about {percent}% of the currently executable market depth. Liquidity may move before you can unwind this position.',
    'module.reverseTokenUnavailable':
      'Current reverse liquidity is effectively unavailable. If you receive {amount}, you may not be able to swap it back to BCH until more liquidity appears.',
    'module.reverseTokenLimited':
      'Current reverse liquidity can only absorb about {amount}. This quote would leave you with more {symbol} than the market can currently swap back to BCH.',
    'module.reverseBchUnavailable':
      'Current BCH-to-{symbol} liquidity is effectively unavailable. If you exit to BCH now, buying back later may not be possible until liquidity returns.',
    'module.reverseBchLimited':
      'Current BCH-to-{symbol} liquidity can only absorb about {amount}. The BCH from this quote would be larger than the market can currently route back into {symbol}.',
    'module.cachedPoolsWarning':
      'Chain confirmation was rate-limited, so this quote used the already-visible pool set. Submit still re-checks chain state before broadcasting.',
    'module.unableToQuote': 'Unable to quote Cauldron swap',
    'module.refreshQuote': 'Refresh the quote before swapping.',
    'module.quoteExpiredChanged':
      'Cauldron quote expired because one or more reviewed pools changed on chain. Get a fresh quote before submitting.',
    'module.quoteExpiredState':
      'Cauldron quote expired against the latest confirmed pool state. Refresh the quote and try again.',
    'module.routeRefreshFailed':
      'Cauldron could not refresh this route with any executable pools for this direction.',
    'module.slippageLimit':
      'The refreshed quote fell below your slippage limit.',
    'module.freshQuoteReview': 'Get a fresh quote before reviewing this swap.',
    'module.payReceive': 'Pay {payUnit}, receive {receiveUnit}',
    'module.swapSubmitted': 'Swap submitted',
    'module.swapBroadcasted': 'Swap broadcasted',
    'module.transactionWatch':
      'Keeping {txid} under watch while the wallet refreshes in the background.',
    'module.broadcastComplete': 'Broadcast completed with {txid}.',
    'module.swapHandoff':
      'Swap handoff pending visibility: {txid}. Keep the txid and avoid sending it again until it appears in history.',
    'module.swapBroadcastedMessage': 'Swap broadcasted: {txid}',
    'module.swapFailed': 'Swap failed',
    'module.cauldronSwapFailed': 'Cauldron swap failed',
    'module.pickTokenCreate': 'Pick a Cauldron token before creating a pool.',
    'module.validPoolBch': 'Enter a valid BCH amount for the pool.',
    'module.validPoolToken': 'Enter a valid {symbol} amount for the pool.',
    'module.noWalletAddress':
      'No wallet address is available for pool creation.',
    'module.selectPool': 'Select a pool first.',
    'module.poolOwnerUnavailable':
      'No wallet address matches this pool owner. Withdraw is not available from this wallet.',
    'module.broadcastingPoolWithdrawal': 'Broadcasting pool withdrawal',
    'module.preparingTransaction': 'Preparing the transaction for submission.',
    'module.poolWithdrawalSubmitted': 'Pool withdrawal submitted',
    'module.poolWithdrawalBroadcasted': 'Pool withdrawal broadcasted',
    'module.poolWithdrawalMessage': 'Pool withdrawal submitted: {txid}',
    'module.unableWithdrawPool': 'Unable to withdraw Cauldron pool',
    'module.broadcastingPoolCreation': 'Broadcasting pool creation',
    'module.poolReviewMissingCategory':
      'Pool review is missing a token category.',
    'module.poolCreationSubmitted': 'Pool creation submitted',
    'module.poolCreationBroadcasted': 'Pool creation broadcasted',
    'module.poolSubmitted': 'Pool submitted: {txid}',
    'module.poolBroadcastFailed': 'Pool broadcast failed',
    'module.unableSubmitPool': 'Unable to submit Cauldron pool transaction',
    'module.adjustedToRange': 'Adjusted to fit range.',
  },
  es: {
    'module.errorLoadMarkets': 'No se pudieron cargar los mercados de Cauldron',
    'module.errorLoadPools': 'No se pudieron cargar los pools de Cauldron',
    'module.marketRatio':
      'Proporción de mercado: {tokenAmount} {symbol} por {bchAmount} BCH.{adjustment}',
    'module.lpRefreshFailed':
      'No se pudieron actualizar los LP. Se muestran los pools en caché.',
    'module.liveUpdateReceived':
      'Se recibió una actualización del pool de Cauldron. Actualiza la cotización antes de intercambiar.',
    'module.poolBchExceedsBalance':
      'La cantidad de BCH del pool supera tu saldo de BCH disponible después de la reserva de comisión de red.',
    'module.poolTokenExceedsBalance':
      'La cantidad de {symbol} del pool supera tu saldo de tokens disponible.',
    'module.pickToken': 'Elige primero un token de Cauldron.',
    'module.validAmount': 'Introduce una cantidad válida mayor que cero.',
    'module.noActivePools':
      'No se encontraron pools activos de Cauldron para este token.',
    'module.minimumRouteAmount':
      'La cantidad está por debajo del mínimo enrutable actual. El mercado necesita al menos {amount} para crear una ruta ejecutable.',
    'module.marketChanged':
      'El mercado visible de Cauldron cambió en la cadena antes de crear esta cotización. Actualiza e inténtalo de nuevo.',
    'module.noQuoteAvailable':
      'No hay una cotización de Cauldron disponible para esa cantidad.',
    'module.noExecutableRoute':
      'Cauldron no pudo crear una ruta con pools ejecutables en esta dirección. Actualiza e inténtalo de nuevo.',
    'module.noSettlementAddress':
      'No hay una dirección de liquidación disponible en la cartera.',
    'module.routeComplex':
      'Esta ruta usa {count} pools y es más compleja que un intercambio normal.',
    'module.walletInputsWarning':
      'Este intercambio gastará {count} entradas de la cartera. Revisa las monedas seleccionadas.',
    'module.slippageWarning':
      'El deslizamiento configurado es del {percent}%, alto para un intercambio confirmado por la cartera.',
    'module.feeWarning':
      'La comisión de red estimada es relativamente alta para este importe ({percent}%).',
    'module.liquidityUsageWarning':
      '{label} usa aproximadamente el {percent}% de la profundidad de mercado ejecutable. La liquidez puede cambiar antes de deshacer la posición.',
    'module.reverseTokenUnavailable':
      'La liquidez inversa actual no está disponible. Si recibes {amount}, quizá no puedas cambiarlo por BCH hasta que haya más liquidez.',
    'module.reverseTokenLimited':
      'La liquidez inversa actual solo puede absorber aproximadamente {amount}. Esta cotización dejaría más {symbol} del que el mercado puede cambiar por BCH.',
    'module.reverseBchUnavailable':
      'La liquidez actual de BCH a {symbol} no está disponible. Si sales a BCH ahora, quizá no puedas volver a comprar hasta que regrese la liquidez.',
    'module.reverseBchLimited':
      'La liquidez actual de BCH a {symbol} solo puede absorber aproximadamente {amount}. El BCH de esta cotización superaría la capacidad de la ruta hacia {symbol}.',
    'module.cachedPoolsWarning':
      'La confirmación de la cadena fue limitada, por lo que se usó el conjunto de pools visible. El envío volverá a comprobar la cadena.',
    'module.unableToQuote':
      'No se pudo obtener la cotización del intercambio de Cauldron',
    'module.refreshQuote': 'Actualiza la cotización antes de intercambiar.',
    'module.quoteExpiredChanged':
      'La cotización de Cauldron caducó porque cambiaron pools revisados en la cadena. Obtén una cotización nueva.',
    'module.quoteExpiredState':
      'La cotización de Cauldron caducó frente al estado confirmado más reciente. Actualízala e inténtalo de nuevo.',
    'module.routeRefreshFailed':
      'Cauldron no pudo actualizar esta ruta con pools ejecutables en esta dirección.',
    'module.slippageLimit':
      'La cotización actualizada quedó por debajo de tu límite de deslizamiento.',
    'module.freshQuoteReview':
      'Obtén una cotización nueva antes de revisar este intercambio.',
    'module.payReceive': 'Pagar {payUnit}, recibir {receiveUnit}',
    'module.swapSubmitted': 'Intercambio enviado',
    'module.swapBroadcasted': 'Intercambio difundido',
    'module.transactionWatch':
      'Se supervisará {txid} mientras la cartera se actualiza en segundo plano.',
    'module.broadcastComplete': 'Difusión completada con {txid}.',
    'module.swapHandoff':
      'Intercambio pendiente de visibilidad: {txid}. Conserva el ID y no lo envíes otra vez hasta que aparezca en el historial.',
    'module.swapBroadcastedMessage': 'Intercambio difundido: {txid}',
    'module.swapFailed': 'Intercambio fallido',
    'module.cauldronSwapFailed': 'Falló el intercambio de Cauldron',
    'module.pickTokenCreate':
      'Elige un token de Cauldron antes de crear un pool.',
    'module.validPoolBch': 'Introduce una cantidad válida de BCH para el pool.',
    'module.validPoolToken':
      'Introduce una cantidad válida de {symbol} para el pool.',
    'module.noWalletAddress':
      'No hay una dirección de cartera disponible para crear el pool.',
    'module.selectPool': 'Selecciona primero un pool.',
    'module.poolOwnerUnavailable':
      'Ninguna dirección de la cartera coincide con el propietario del pool. Esta cartera no puede retirarlo.',
    'module.broadcastingPoolWithdrawal': 'Difundiendo el retiro del pool',
    'module.preparingTransaction': 'Preparando la transacción para enviarla.',
    'module.poolWithdrawalSubmitted': 'Retiro del pool enviado',
    'module.poolWithdrawalBroadcasted': 'Retiro del pool difundido',
    'module.poolWithdrawalMessage': 'Retiro del pool enviado: {txid}',
    'module.unableWithdrawPool': 'No se pudo retirar el pool de Cauldron',
    'module.broadcastingPoolCreation': 'Difundiendo la creación del pool',
    'module.poolReviewMissingCategory':
      'La revisión del pool no incluye una categoría de token.',
    'module.poolCreationSubmitted': 'Creación del pool enviada',
    'module.poolCreationBroadcasted': 'Creación del pool difundida',
    'module.poolSubmitted': 'Pool enviado: {txid}',
    'module.poolBroadcastFailed': 'Falló la difusión del pool',
    'module.unableSubmitPool':
      'No se pudo enviar la transacción del pool de Cauldron',
    'module.adjustedToRange': 'Ajustado al rango.',
  },
  'pt-BR': {
    'module.errorLoadMarkets':
      'Não foi possível carregar os mercados do Cauldron',
    'module.errorLoadPools': 'Não foi possível carregar os pools do Cauldron',
    'module.marketRatio':
      'Proporção de mercado: {tokenAmount} {symbol} por {bchAmount} BCH.{adjustment}',
    'module.lpRefreshFailed':
      'Falha ao atualizar LPs. Exibindo pools em cache.',
    'module.liveUpdateReceived':
      'Atualização ao vivo do pool Cauldron recebida. Atualize a cotação antes de trocar.',
    'module.poolBchExceedsBalance':
      'O BCH do pool excede seu saldo de BCH disponível após a reserva da taxa de rede.',
    'module.poolTokenExceedsBalance':
      'A quantidade de {symbol} do pool excede seu saldo de tokens disponível.',
    'module.pickToken': 'Escolha primeiro um token do Cauldron.',
    'module.validAmount': 'Insira um valor válido maior que zero.',
    'module.noActivePools':
      'Nenhum pool ativo do Cauldron foi encontrado para este token.',
    'module.minimumRouteAmount':
      'Esse valor está abaixo do mínimo roteável atual. O mercado precisa de pelo menos {amount} para criar uma rota executável.',
    'module.marketChanged':
      'O mercado visível do Cauldron mudou na rede antes de criar esta cotação. Atualize e tente novamente.',
    'module.noQuoteAvailable':
      'Não há cotação do Cauldron disponível para esse valor.',
    'module.noExecutableRoute':
      'O Cauldron não conseguiu criar uma rota com pools executáveis nesta direção. Atualize e tente novamente.',
    'module.noSettlementAddress':
      'Nenhum endereço de liquidação da carteira está disponível.',
    'module.routeComplex':
      'Esta rota usa {count} pools e é mais complexa que uma troca comum.',
    'module.walletInputsWarning':
      'Esta troca gastará {count} entradas da carteira. Revise as moedas selecionadas.',
    'module.slippageWarning':
      'A derrapagem configurada é de {percent}%, alta para uma troca confirmada pela carteira.',
    'module.feeWarning':
      'A taxa de rede estimada é relativamente alta para este valor ({percent}%).',
    'module.liquidityUsageWarning':
      '{label} usa cerca de {percent}% da profundidade de mercado executável. A liquidez pode mudar antes que você desfaça a posição.',
    'module.reverseTokenUnavailable':
      'A liquidez reversa atual está indisponível. Se você receber {amount}, talvez não possa trocá-lo por BCH até surgir mais liquidez.',
    'module.reverseTokenLimited':
      'A liquidez reversa atual absorve apenas cerca de {amount}. Esta cotação deixaria mais {symbol} do que o mercado consegue trocar por BCH.',
    'module.reverseBchUnavailable':
      'A liquidez atual de BCH para {symbol} está indisponível. Se sair para BCH agora, talvez não consiga recomprar até a liquidez voltar.',
    'module.reverseBchLimited':
      'A liquidez atual de BCH para {symbol} absorve apenas cerca de {amount}. O BCH desta cotação excederia a capacidade de rota para {symbol}.',
    'module.cachedPoolsWarning':
      'A confirmação da rede sofreu limitação, então esta cotação usou os pools já visíveis. O envio ainda verifica a rede antes da transmissão.',
    'module.unableToQuote':
      'Não foi possível obter a cotação da troca do Cauldron',
    'module.refreshQuote': 'Atualize a cotação antes de trocar.',
    'module.quoteExpiredChanged':
      'A cotação do Cauldron expirou porque um ou mais pools revisados mudaram na rede. Obtenha uma nova cotação.',
    'module.quoteExpiredState':
      'A cotação do Cauldron expirou diante do estado confirmado mais recente. Atualize e tente novamente.',
    'module.routeRefreshFailed':
      'O Cauldron não conseguiu atualizar esta rota com pools executáveis nesta direção.',
    'module.slippageLimit':
      'A cotação atualizada ficou abaixo do seu limite de derrapagem.',
    'module.freshQuoteReview':
      'Obtenha uma nova cotação antes de revisar esta troca.',
    'module.payReceive': 'Pagar {payUnit}, receber {receiveUnit}',
    'module.swapSubmitted': 'Troca enviada',
    'module.swapBroadcasted': 'Troca transmitida',
    'module.transactionWatch':
      'Mantendo {txid} sob observação enquanto a carteira é atualizada em segundo plano.',
    'module.broadcastComplete': 'Transmissão concluída com {txid}.',
    'module.swapHandoff':
      'Troca aguardando visibilidade: {txid}. Guarde o ID e não envie novamente até ele aparecer no histórico.',
    'module.swapBroadcastedMessage': 'Troca transmitida: {txid}',
    'module.swapFailed': 'Falha na troca',
    'module.cauldronSwapFailed': 'Falha na troca do Cauldron',
    'module.pickTokenCreate':
      'Escolha um token do Cauldron antes de criar um pool.',
    'module.validPoolBch': 'Insira um valor válido de BCH para o pool.',
    'module.validPoolToken': 'Insira um valor válido de {symbol} para o pool.',
    'module.noWalletAddress':
      'Nenhum endereço da carteira está disponível para criar o pool.',
    'module.selectPool': 'Selecione um pool primeiro.',
    'module.poolOwnerUnavailable':
      'Nenhum endereço da carteira corresponde ao proprietário deste pool. Esta carteira não pode fazer o saque.',
    'module.broadcastingPoolWithdrawal': 'Transmitindo o saque do pool',
    'module.preparingTransaction': 'Preparando a transação para envio.',
    'module.poolWithdrawalSubmitted': 'Saque do pool enviado',
    'module.poolWithdrawalBroadcasted': 'Saque do pool transmitido',
    'module.poolWithdrawalMessage': 'Saque do pool enviado: {txid}',
    'module.unableWithdrawPool': 'Não foi possível sacar o pool do Cauldron',
    'module.broadcastingPoolCreation': 'Transmitindo a criação do pool',
    'module.poolReviewMissingCategory':
      'A revisão do pool não contém uma categoria de token.',
    'module.poolCreationSubmitted': 'Criação do pool enviada',
    'module.poolCreationBroadcasted': 'Criação do pool transmitida',
    'module.poolSubmitted': 'Pool enviado: {txid}',
    'module.poolBroadcastFailed': 'Falha ao transmitir o pool',
    'module.unableSubmitPool':
      'Não foi possível enviar a transação do pool do Cauldron',
    'module.adjustedToRange': 'Ajustado ao intervalo.',
  },
  'zh-CN': {
    'module.errorLoadMarkets': '无法加载 Cauldron 市场',
    'module.errorLoadPools': '无法加载 Cauldron 池',
    'module.marketRatio':
      '市场比例：{bchAmount} BCH 对应 {tokenAmount} {symbol}。{adjustment}',
    'module.lpRefreshFailed': 'LP 刷新失败，正在显示缓存的池。',
    'module.liveUpdateReceived':
      '收到 Cauldron 池的实时更新。兑换前请刷新报价。',
    'module.poolBchExceedsBalance':
      '池 BCH 数量超过扣除网络费缓冲后的可用 BCH 余额。',
    'module.poolTokenExceedsBalance': '池 {symbol} 数量超过可用代币余额。',
    'module.pickToken': '请先选择 Cauldron 代币。',
    'module.validAmount': '请输入大于零的有效数量。',
    'module.noActivePools': '未找到该代币的活跃 Cauldron 池。',
    'module.minimumRouteAmount':
      '该数量低于当前可路由市场的最小值。市场至少需要 {amount} 才能建立可执行路线。',
    'module.marketChanged':
      '报价建立前，链上的可见 Cauldron 市场已发生变化。请刷新后重试。',
    'module.noQuoteAvailable': '当前没有该数量的 Cauldron 报价。',
    'module.noExecutableRoute':
      'Cauldron 无法在此方向使用可执行池建立路线。请刷新后重试。',
    'module.noSettlementAddress': '没有可用的钱包结算地址。',
    'module.routeComplex': '此路线使用 {count} 个池，比普通兑换更复杂。',
    'module.walletInputsWarning':
      '此次兑换将使用钱包中的 {count} 个输入。请仔细检查所选币。',
    'module.slippageWarning':
      '滑点设置为 {percent}%，对于钱包确认的兑换来说偏高。',
    'module.feeWarning': '预计网络费相对于交易金额偏高（{percent}%）。',
    'module.liquidityUsageWarning':
      '{label} 使用了当前可执行市场深度的约 {percent}%。流动性可能在你退出该仓位前发生变化。',
    'module.reverseTokenUnavailable':
      '当前反向流动性基本不可用。若收到 {amount}，在流动性增加前可能无法将其兑换回 BCH。',
    'module.reverseTokenLimited':
      '当前反向流动性最多只能吸收约 {amount}。该报价会让你的 {symbol} 超过市场当前兑换回 BCH 的能力。',
    'module.reverseBchUnavailable':
      '当前 BCH 到 {symbol} 的流动性基本不可用。现在退出到 BCH 后，流动性恢复前可能无法再次买回。',
    'module.reverseBchLimited':
      '当前 BCH 到 {symbol} 的流动性最多只能吸收约 {amount}。该报价产生的 BCH 超过市场当前路由回 {symbol} 的能力。',
    'module.cachedPoolsWarning':
      '链确认受到速率限制，因此报价使用了当前可见的池。提交前仍会重新检查链状态。',
    'module.unableToQuote': '无法为 Cauldron 兑换生成报价',
    'module.refreshQuote': '兑换前请刷新报价。',
    'module.quoteExpiredChanged':
      'Cauldron 报价已过期，因为审核过的池在链上发生了变化。请获取新报价。',
    'module.quoteExpiredState':
      'Cauldron 报价与最新确认的池状态不一致，已过期。请刷新报价后重试。',
    'module.routeRefreshFailed': 'Cauldron 无法在此方向使用可执行池刷新路线。',
    'module.slippageLimit': '刷新后的报价低于你的滑点限制。',
    'module.freshQuoteReview': '审核兑换前请获取新报价。',
    'module.payReceive': '支付 {payUnit}，接收 {receiveUnit}',
    'module.swapSubmitted': '兑换已提交',
    'module.swapBroadcasted': '兑换已广播',
    'module.transactionWatch': '钱包在后台刷新期间将持续关注 {txid}。',
    'module.broadcastComplete': '已完成广播：{txid}。',
    'module.swapHandoff':
      '兑换等待显示：{txid}。请保存交易 ID，在历史记录出现前不要再次发送。',
    'module.swapBroadcastedMessage': '兑换已广播：{txid}',
    'module.swapFailed': '兑换失败',
    'module.cauldronSwapFailed': 'Cauldron 兑换失败',
    'module.pickTokenCreate': '创建池前请先选择 Cauldron 代币。',
    'module.validPoolBch': '请输入有效的池 BCH 数量。',
    'module.validPoolToken': '请输入有效的池 {symbol} 数量。',
    'module.noWalletAddress': '没有可用于创建池的钱包地址。',
    'module.selectPool': '请先选择一个池。',
    'module.poolOwnerUnavailable':
      '没有钱包地址与该池所有者匹配，当前钱包无法提取。',
    'module.broadcastingPoolWithdrawal': '正在广播池提取交易',
    'module.preparingTransaction': '正在准备提交交易。',
    'module.poolWithdrawalSubmitted': '池提取已提交',
    'module.poolWithdrawalBroadcasted': '池提取已广播',
    'module.poolWithdrawalMessage': '池提取已提交：{txid}',
    'module.unableWithdrawPool': '无法提取 Cauldron 池',
    'module.broadcastingPoolCreation': '正在广播创建池交易',
    'module.poolReviewMissingCategory': '池审核缺少代币类别。',
    'module.poolCreationSubmitted': '创建池已提交',
    'module.poolCreationBroadcasted': '创建池已广播',
    'module.poolSubmitted': '池已提交：{txid}',
    'module.poolBroadcastFailed': '池广播失败',
    'module.unableSubmitPool': '无法提交 Cauldron 池交易',
    'module.adjustedToRange': '已调整到范围内。',
  },
  'zh-TW': {
    'module.errorLoadMarkets': '無法載入 Cauldron 市場',
    'module.errorLoadPools': '無法載入 Cauldron 池',
    'module.marketRatio':
      '市場比例：{bchAmount} BCH 對應 {tokenAmount} {symbol}。{adjustment}',
    'module.lpRefreshFailed': 'LP 更新失敗，正在顯示快取的池。',
    'module.liveUpdateReceived':
      '收到 Cauldron 池的即時更新。兌換前請重新整理報價。',
    'module.poolBchExceedsBalance':
      '池 BCH 數量超過扣除網路費緩衝後的可用 BCH 餘額。',
    'module.poolTokenExceedsBalance': '池 {symbol} 數量超過可用代幣餘額。',
    'module.pickToken': '請先選擇 Cauldron 代幣。',
    'module.validAmount': '請輸入大於零的有效數量。',
    'module.noActivePools': '找不到此代幣的有效 Cauldron 池。',
    'module.minimumRouteAmount':
      '此數量低於目前可路由市場的最小值。市場至少需要 {amount} 才能建立可執行路線。',
    'module.marketChanged':
      '建立報價前，鏈上的可見 Cauldron 市場已變更。請重新整理後再試。',
    'module.noQuoteAvailable': '目前沒有此數量的 Cauldron 報價。',
    'module.noExecutableRoute':
      'Cauldron 無法在此方向使用可執行池建立路線。請重新整理後再試。',
    'module.noSettlementAddress': '沒有可用的錢包結算地址。',
    'module.routeComplex': '此路線使用 {count} 個池，比一般兌換更複雜。',
    'module.walletInputsWarning':
      '此兌換將使用錢包中的 {count} 個輸入。請仔細檢查所選硬幣。',
    'module.slippageWarning':
      '滑點設定為 {percent}%，對錢包確認的兌換而言偏高。',
    'module.feeWarning': '預估網路費相對於此交易金額偏高（{percent}%）。',
    'module.liquidityUsageWarning':
      '{label} 使用了目前可執行市場深度約 {percent}%。流動性可能在你退出此部位前變動。',
    'module.reverseTokenUnavailable':
      '目前反向流動性幾乎不可用。若收到 {amount}，在流動性增加前可能無法將其兌回 BCH。',
    'module.reverseTokenLimited':
      '目前反向流動性最多只能吸收約 {amount}。此報價會讓你的 {symbol} 超過市場目前兌回 BCH 的能力。',
    'module.reverseBchUnavailable':
      '目前 BCH 至 {symbol} 的流動性幾乎不可用。現在退出至 BCH 後，流動性恢復前可能無法再次買回。',
    'module.reverseBchLimited':
      '目前 BCH 至 {symbol} 的流動性最多只能吸收約 {amount}。此報價產生的 BCH 超過市場目前路由回 {symbol} 的能力。',
    'module.cachedPoolsWarning':
      '鏈上確認受到速率限制，因此此報價使用了目前可見的池。提交前仍會重新檢查鏈上狀態。',
    'module.unableToQuote': '無法為 Cauldron 兌換產生報價',
    'module.refreshQuote': '兌換前請重新整理報價。',
    'module.quoteExpiredChanged':
      'Cauldron 報價已過期，因為已檢視的池在鏈上發生變更。請取得新報價。',
    'module.quoteExpiredState':
      'Cauldron 報價與最新確認的池狀態不一致，已過期。請重新整理後再試。',
    'module.routeRefreshFailed': 'Cauldron 無法在此方向使用可執行池更新路線。',
    'module.slippageLimit': '更新後的報價低於你的滑點限制。',
    'module.freshQuoteReview': '檢視此兌換前請取得新報價。',
    'module.payReceive': '支付 {payUnit}，接收 {receiveUnit}',
    'module.swapSubmitted': '兌換已提交',
    'module.swapBroadcasted': '兌換已廣播',
    'module.transactionWatch': '錢包在背景更新期間會持續追蹤 {txid}。',
    'module.broadcastComplete': '已完成廣播：{txid}。',
    'module.swapHandoff':
      '兌換等待顯示：{txid}。請保留交易 ID，在歷史記錄出現前不要再次傳送。',
    'module.swapBroadcastedMessage': '兌換已廣播：{txid}',
    'module.swapFailed': '兌換失敗',
    'module.cauldronSwapFailed': 'Cauldron 兌換失敗',
    'module.pickTokenCreate': '建立池前請先選擇 Cauldron 代幣。',
    'module.validPoolBch': '請輸入有效的池 BCH 數量。',
    'module.validPoolToken': '請輸入有效的池 {symbol} 數量。',
    'module.noWalletAddress': '沒有可用於建立池的錢包地址。',
    'module.selectPool': '請先選擇一個池。',
    'module.poolOwnerUnavailable':
      '沒有錢包地址符合此池擁有者，目前錢包無法提取。',
    'module.broadcastingPoolWithdrawal': '正在廣播池提取交易',
    'module.preparingTransaction': '正在準備提交交易。',
    'module.poolWithdrawalSubmitted': '池提取已提交',
    'module.poolWithdrawalBroadcasted': '池提取已廣播',
    'module.poolWithdrawalMessage': '池提取已提交：{txid}',
    'module.unableWithdrawPool': '無法提取 Cauldron 池',
    'module.broadcastingPoolCreation': '正在廣播建立池交易',
    'module.poolReviewMissingCategory': '池檢視缺少代幣類別。',
    'module.poolCreationSubmitted': '建立池已提交',
    'module.poolCreationBroadcasted': '建立池已廣播',
    'module.poolSubmitted': '池已提交：{txid}',
    'module.poolBroadcastFailed': '池廣播失敗',
    'module.unableSubmitPool': '無法提交 Cauldron 池交易',
    'module.adjustedToRange': '已調整至範圍內。',
  },
  vi: {
    'module.errorLoadMarkets': 'Không thể tải các thị trường Cauldron',
    'module.errorLoadPools': 'Không thể tải các pool Cauldron',
    'module.marketRatio':
      'Tỷ lệ thị trường: {tokenAmount} {symbol} cho {bchAmount} BCH.{adjustment}',
    'module.lpRefreshFailed':
      'Không thể làm mới LP. Đang hiển thị các pool đã lưu.',
    'module.liveUpdateReceived':
      'Đã nhận cập nhật trực tiếp của pool Cauldron. Hãy làm mới báo giá trước khi hoán đổi.',
    'module.poolBchExceedsBalance':
      'Lượng BCH trong pool vượt quá số dư BCH có thể chi tiêu sau phần đệm phí mạng.',
    'module.poolTokenExceedsBalance':
      'Lượng {symbol} trong pool vượt quá số dư token khả dụng.',
    'module.pickToken': 'Trước hết hãy chọn token Cauldron.',
    'module.validAmount': 'Nhập số lượng hợp lệ lớn hơn không.',
    'module.noActivePools':
      'Không tìm thấy pool Cauldron đang hoạt động cho token này.',
    'module.minimumRouteAmount':
      'Số lượng đó thấp hơn quy mô thị trường tối thiểu có thể định tuyến. Thị trường cần ít nhất {amount} để tạo tuyến có thể thực thi.',
    'module.marketChanged':
      'Thị trường Cauldron đang hiển thị đã thay đổi trên chuỗi trước khi tạo báo giá. Hãy làm mới và thử lại.',
    'module.noQuoteAvailable':
      'Hiện không có báo giá Cauldron cho số lượng đó.',
    'module.noExecutableRoute':
      'Cauldron không thể tạo tuyến bằng các pool có thể thực thi theo hướng này. Hãy làm mới và thử lại.',
    'module.noSettlementAddress':
      'Không có địa chỉ thanh toán của ví khả dụng.',
    'module.routeComplex':
      'Tuyến này dùng {count} pool, phức tạp hơn một lần hoán đổi thông thường.',
    'module.walletInputsWarning':
      'Lần hoán đổi này sẽ dùng {count} đầu vào ví. Hãy kiểm tra kỹ các coin đã chọn.',
    'module.slippageWarning':
      'Mức trượt giá là {percent}%, cao đối với giao dịch được ví xác nhận.',
    'module.feeWarning':
      'Phí mạng ước tính tương đối cao so với quy mô giao dịch ({percent}%).',
    'module.liquidityUsageWarning':
      '{label} đang dùng khoảng {percent}% độ sâu thị trường có thể thực thi. Thanh khoản có thể thay đổi trước khi bạn thoát vị thế.',
    'module.reverseTokenUnavailable':
      'Thanh khoản ngược hiện gần như không khả dụng. Nếu nhận {amount}, bạn có thể không đổi lại được sang BCH cho đến khi có thêm thanh khoản.',
    'module.reverseTokenLimited':
      'Thanh khoản ngược hiện chỉ hấp thụ được khoảng {amount}. Báo giá này sẽ để lại nhiều {symbol} hơn khả năng đổi lại sang BCH của thị trường.',
    'module.reverseBchUnavailable':
      'Thanh khoản BCH sang {symbol} hiện gần như không khả dụng. Nếu thoát sang BCH ngay, bạn có thể không mua lại được cho đến khi thanh khoản trở lại.',
    'module.reverseBchLimited':
      'Thanh khoản BCH sang {symbol} hiện chỉ hấp thụ được khoảng {amount}. BCH từ báo giá này vượt quá khả năng định tuyến về {symbol} hiện tại.',
    'module.cachedPoolsWarning':
      'Xác nhận chuỗi bị giới hạn tốc độ nên báo giá dùng tập pool đã hiển thị. Khi gửi, trạng thái chuỗi vẫn được kiểm tra lại.',
    'module.unableToQuote': 'Không thể báo giá giao dịch Cauldron',
    'module.refreshQuote': 'Hãy làm mới báo giá trước khi hoán đổi.',
    'module.quoteExpiredChanged':
      'Báo giá Cauldron đã hết hạn vì một hoặc nhiều pool đã xem thay đổi trên chuỗi. Hãy lấy báo giá mới.',
    'module.quoteExpiredState':
      'Báo giá Cauldron đã hết hạn so với trạng thái pool mới nhất đã xác nhận. Hãy làm mới và thử lại.',
    'module.routeRefreshFailed':
      'Cauldron không thể làm mới tuyến bằng các pool có thể thực thi theo hướng này.',
    'module.slippageLimit':
      'Báo giá sau khi làm mới thấp hơn giới hạn trượt giá của bạn.',
    'module.freshQuoteReview':
      'Hãy lấy báo giá mới trước khi xem lại giao dịch này.',
    'module.payReceive': 'Trả {payUnit}, nhận {receiveUnit}',
    'module.swapSubmitted': 'Đã gửi hoán đổi',
    'module.swapBroadcasted': 'Đã phát hoán đổi',
    'module.transactionWatch':
      'Đang theo dõi {txid} trong khi ví cập nhật ở chế độ nền.',
    'module.broadcastComplete': 'Đã phát xong với {txid}.',
    'module.swapHandoff':
      'Hoán đổi đang chờ hiển thị: {txid}. Hãy giữ mã giao dịch và không gửi lại cho đến khi thấy trong lịch sử.',
    'module.swapBroadcastedMessage': 'Đã phát hoán đổi: {txid}',
    'module.swapFailed': 'Hoán đổi thất bại',
    'module.cauldronSwapFailed': 'Hoán đổi Cauldron thất bại',
    'module.pickTokenCreate': 'Hãy chọn token Cauldron trước khi tạo pool.',
    'module.validPoolBch': 'Nhập lượng BCH hợp lệ cho pool.',
    'module.validPoolToken': 'Nhập lượng {symbol} hợp lệ cho pool.',
    'module.noWalletAddress': 'Không có địa chỉ ví để tạo pool.',
    'module.selectPool': 'Trước hết hãy chọn một pool.',
    'module.poolOwnerUnavailable':
      'Không có địa chỉ ví nào khớp với chủ pool này. Ví này không thể rút.',
    'module.broadcastingPoolWithdrawal': 'Đang phát giao dịch rút khỏi pool',
    'module.preparingTransaction': 'Đang chuẩn bị giao dịch để gửi.',
    'module.poolWithdrawalSubmitted': 'Đã gửi giao dịch rút khỏi pool',
    'module.poolWithdrawalBroadcasted': 'Đã phát giao dịch rút khỏi pool',
    'module.poolWithdrawalMessage': 'Đã gửi giao dịch rút khỏi pool: {txid}',
    'module.unableWithdrawPool': 'Không thể rút khỏi pool Cauldron',
    'module.broadcastingPoolCreation': 'Đang phát giao dịch tạo pool',
    'module.poolReviewMissingCategory':
      'Bản xem lại pool thiếu danh mục token.',
    'module.poolCreationSubmitted': 'Đã gửi giao dịch tạo pool',
    'module.poolCreationBroadcasted': 'Đã phát giao dịch tạo pool',
    'module.poolSubmitted': 'Đã gửi pool: {txid}',
    'module.poolBroadcastFailed': 'Phát pool thất bại',
    'module.unableSubmitPool': 'Không thể gửi giao dịch pool Cauldron',
    'module.adjustedToRange': 'Đã điều chỉnh trong phạm vi.',
  },
  ar: {
    'module.errorLoadMarkets': 'تعذر تحميل أسواق Cauldron',
    'module.errorLoadPools': 'تعذر تحميل مجمعات Cauldron',
    'module.marketRatio':
      'نسبة السوق: ‏{tokenAmount}‏ {symbol} مقابل ‏{bchAmount}‏ BCH.‏{adjustment}',
    'module.lpRefreshFailed': 'تعذر تحديث LP. يتم عرض المجمعات المخزنة مؤقتًا.',
    'module.liveUpdateReceived':
      'تم استلام تحديث مباشر لمجمع Cauldron. حدّث العرض قبل المبادلة.',
    'module.poolBchExceedsBalance':
      'تتجاوز كمية BCH في المجمع رصيد BCH القابل للإنفاق بعد احتياطي رسوم الشبكة.',
    'module.poolTokenExceedsBalance':
      'تتجاوز كمية {symbol} في المجمع رصيد الرموز المتاح.',
    'module.pickToken': 'اختر رمز Cauldron أولًا.',
    'module.validAmount': 'أدخل كمية صالحة أكبر من صفر.',
    'module.noActivePools':
      'لم يتم العثور على مجمعات Cauldron نشطة لهذا الرمز.',
    'module.minimumRouteAmount':
      'هذه الكمية أقل من الحد الأدنى الحالي للسوق القابل للتوجيه. يحتاج السوق إلى {amount} على الأقل لإنشاء مسار قابل للتنفيذ.',
    'module.marketChanged':
      'تغيّر سوق Cauldron الظاهر على السلسلة قبل إنشاء هذا العرض. حدّث وحاول مرة أخرى.',
    'module.noQuoteAvailable': 'لا يتوفر حاليًا عرض Cauldron لهذه الكمية.',
    'module.noExecutableRoute':
      'تعذر على Cauldron إنشاء مسار باستخدام مجمعات قابلة للتنفيذ في هذا الاتجاه. حدّث وحاول مرة أخرى.',
    'module.noSettlementAddress': 'لا يتوفر عنوان تسوية للمحفظة.',
    'module.routeComplex':
      'يستخدم هذا المسار {count} من المجمعات، وهو أكثر تعقيدًا من المبادلة المعتادة.',
    'module.walletInputsWarning':
      'ستستخدم هذه المبادلة {count} من مدخلات المحفظة. راجع العملات المحددة بعناية.',
    'module.slippageWarning':
      'إعداد الانزلاق هو {percent}%، وهو مرتفع لمبادلة تؤكدها المحفظة.',
    'module.feeWarning':
      'رسوم الشبكة المقدرة مرتفعة نسبيًا لحجم هذه المعاملة ({percent}%).',
    'module.liquidityUsageWarning':
      'يستخدم {label} نحو {percent}% من عمق السوق القابل للتنفيذ حاليًا. قد تتغير السيولة قبل أن تتمكن من إغلاق المركز.',
    'module.reverseTokenUnavailable':
      'السيولة العكسية الحالية غير متاحة فعليًا. إذا استلمت {amount} فقد لا تتمكن من مبادلته إلى BCH حتى تظهر سيولة أكبر.',
    'module.reverseTokenLimited':
      'لا تستطيع السيولة العكسية الحالية استيعاب أكثر من نحو {amount}. سيتركك هذا العرض بكمية {symbol} أكبر مما يستطيع السوق مبادلته إلى BCH.',
    'module.reverseBchUnavailable':
      'سيولة BCH إلى {symbol} الحالية غير متاحة فعليًا. إذا خرجت إلى BCH الآن فقد لا تتمكن من الشراء مجددًا حتى تعود السيولة.',
    'module.reverseBchLimited':
      'لا تستطيع سيولة BCH إلى {symbol} الحالية استيعاب أكثر من نحو {amount}. تتجاوز BCH الناتجة قدرة السوق الحالية على التوجيه إلى {symbol}.',
    'module.cachedPoolsWarning':
      'تم تقييد تأكيد السلسلة، لذلك استخدم هذا العرض مجموعة المجمعات الظاهرة بالفعل. سيُعاد فحص حالة السلسلة قبل البث.',
    'module.unableToQuote': 'تعذر إنشاء عرض لمبادلة Cauldron',
    'module.refreshQuote': 'حدّث العرض قبل المبادلة.',
    'module.quoteExpiredChanged':
      'انتهت صلاحية عرض Cauldron لأن مجمعًا أو أكثر من المجمعات التي تمت مراجعتها تغيّر على السلسلة. احصل على عرض جديد.',
    'module.quoteExpiredState':
      'انتهت صلاحية عرض Cauldron مقارنة بأحدث حالة مؤكدة للمجمع. حدّث العرض وحاول مرة أخرى.',
    'module.routeRefreshFailed':
      'تعذر على Cauldron تحديث هذا المسار باستخدام مجمعات قابلة للتنفيذ في هذا الاتجاه.',
    'module.slippageLimit': 'انخفض العرض المحدّث عن حد الانزلاق الذي حددته.',
    'module.freshQuoteReview': 'احصل على عرض جديد قبل مراجعة هذه المبادلة.',
    'module.payReceive': 'ادفع {payUnit} واستلم {receiveUnit}',
    'module.swapSubmitted': 'تم إرسال المبادلة',
    'module.swapBroadcasted': 'تم بث المبادلة',
    'module.transactionWatch':
      'تتم مراقبة {txid} بينما تحدّث المحفظة البيانات في الخلفية.',
    'module.broadcastComplete': 'اكتمل البث باستخدام {txid}.',
    'module.swapHandoff':
      'المبادلة بانتظار الظهور: {txid}. احتفظ بالمعرّف ولا ترسلها مجددًا حتى تظهر في السجل.',
    'module.swapBroadcastedMessage': 'تم بث المبادلة: {txid}',
    'module.swapFailed': 'فشلت المبادلة',
    'module.cauldronSwapFailed': 'فشلت مبادلة Cauldron',
    'module.pickTokenCreate': 'اختر رمز Cauldron قبل إنشاء مجمع.',
    'module.validPoolBch': 'أدخل كمية BCH صالحة للمجمع.',
    'module.validPoolToken': 'أدخل كمية {symbol} صالحة للمجمع.',
    'module.noWalletAddress': 'لا يتوفر عنوان محفظة لإنشاء المجمع.',
    'module.selectPool': 'اختر مجمعًا أولًا.',
    'module.poolOwnerUnavailable':
      'لا يطابق أي عنوان في المحفظة مالك هذا المجمع. لا يمكن السحب من هذه المحفظة.',
    'module.broadcastingPoolWithdrawal': 'جارٍ بث سحب المجمع',
    'module.preparingTransaction': 'جارٍ تجهيز المعاملة للإرسال.',
    'module.poolWithdrawalSubmitted': 'تم إرسال سحب المجمع',
    'module.poolWithdrawalBroadcasted': 'تم بث سحب المجمع',
    'module.poolWithdrawalMessage': 'تم إرسال سحب المجمع: {txid}',
    'module.unableWithdrawPool': 'تعذر سحب مجمع Cauldron',
    'module.broadcastingPoolCreation': 'جارٍ بث إنشاء المجمع',
    'module.poolReviewMissingCategory': 'تنقص مراجعة المجمع فئة الرمز.',
    'module.poolCreationSubmitted': 'تم إرسال إنشاء المجمع',
    'module.poolCreationBroadcasted': 'تم بث إنشاء المجمع',
    'module.poolSubmitted': 'تم إرسال المجمع: {txid}',
    'module.poolBroadcastFailed': 'فشل بث المجمع',
    'module.unableSubmitPool': 'تعذر إرسال معاملة مجمع Cauldron',
    'module.adjustedToRange': 'تم الضبط ضمن النطاق.',
  },
  fr: {
    'module.errorLoadMarkets': 'Impossible de charger les marchés Cauldron',
    'module.errorLoadPools': 'Impossible de charger les pools Cauldron',
    'module.marketRatio':
      'Ratio du marché : {tokenAmount} {symbol} pour {bchAmount} BCH.{adjustment}',
    'module.lpRefreshFailed':
      'Échec de l’actualisation des LP. Affichage des pools en cache.',
    'module.liveUpdateReceived':
      'Mise à jour en direct du pool Cauldron reçue. Actualisez le devis avant d’échanger.',
    'module.poolBchExceedsBalance':
      'Le montant de BCH du pool dépasse votre solde de BCH disponible après la réserve de frais réseau.',
    'module.poolTokenExceedsBalance':
      'Le montant de {symbol} du pool dépasse votre solde de tokens disponible.',
    'module.pickToken': 'Sélectionnez d’abord un token Cauldron.',
    'module.validAmount': 'Saisissez un montant valide supérieur à zéro.',
    'module.noActivePools': 'Aucun pool Cauldron actif trouvé pour ce token.',
    'module.minimumRouteAmount':
      'Ce montant est inférieur au minimum routable actuel. Le marché nécessite au moins {amount} pour créer une route exécutable.',
    'module.marketChanged':
      'Le marché Cauldron visible a changé sur la chaîne avant la création du devis. Actualisez et réessayez.',
    'module.noQuoteAvailable':
      'Aucun devis Cauldron n’est actuellement disponible pour ce montant.',
    'module.noExecutableRoute':
      'Cauldron n’a pas pu créer de route avec des pools exécutables dans ce sens. Actualisez et réessayez.',
    'module.noSettlementAddress':
      'Aucune adresse de règlement du portefeuille n’est disponible.',
    'module.routeComplex':
      'Cette route utilise {count} pools et est plus complexe qu’un échange habituel.',
    'module.walletInputsWarning':
      'Cet échange dépensera {count} entrées du portefeuille. Vérifiez attentivement les pièces sélectionnées.',
    'module.slippageWarning':
      'Le slippage configuré est de {percent} %, élevé pour un échange confirmé par le portefeuille.',
    'module.feeWarning':
      'Les frais réseau estimés sont relativement élevés pour ce montant ({percent} %).',
    'module.liquidityUsageWarning':
      '{label} utilise environ {percent} % de la profondeur de marché actuellement exécutable. La liquidité peut changer avant la sortie de cette position.',
    'module.reverseTokenUnavailable':
      'La liquidité inverse actuelle est pratiquement indisponible. Si vous recevez {amount}, vous ne pourrez peut-être pas le reconvertir en BCH avant le retour de la liquidité.',
    'module.reverseTokenLimited':
      'La liquidité inverse actuelle ne peut absorber qu’environ {amount}. Ce devis laisserait plus de {symbol} que le marché ne peut actuellement reconvertir en BCH.',
    'module.reverseBchUnavailable':
      'La liquidité actuelle de BCH vers {symbol} est pratiquement indisponible. Une sortie vers BCH maintenant pourrait empêcher un rachat avant le retour de la liquidité.',
    'module.reverseBchLimited':
      'La liquidité actuelle de BCH vers {symbol} ne peut absorber qu’environ {amount}. Le BCH de ce devis dépasse la capacité de routage actuelle vers {symbol}.',
    'module.cachedPoolsWarning':
      'La confirmation de la chaîne a été limitée, ce devis utilise donc les pools déjà visibles. L’état de la chaîne sera revérifié avant la diffusion.',
    'module.unableToQuote':
      'Impossible d’obtenir le devis de l’échange Cauldron',
    'module.refreshQuote': 'Actualisez le devis avant d’échanger.',
    'module.quoteExpiredChanged':
      'Le devis Cauldron a expiré car un ou plusieurs pools vérifiés ont changé sur la chaîne. Obtenez un nouveau devis.',
    'module.quoteExpiredState':
      'Le devis Cauldron a expiré par rapport au dernier état confirmé du pool. Actualisez et réessayez.',
    'module.routeRefreshFailed':
      'Cauldron n’a pas pu actualiser cette route avec des pools exécutables dans ce sens.',
    'module.slippageLimit':
      'Le devis actualisé est inférieur à votre limite de slippage.',
    'module.freshQuoteReview':
      'Obtenez un nouveau devis avant de vérifier cet échange.',
    'module.payReceive': 'Payer {payUnit}, recevoir {receiveUnit}',
    'module.swapSubmitted': 'Échange envoyé',
    'module.swapBroadcasted': 'Échange diffusé',
    'module.transactionWatch':
      'Surveillance de {txid} pendant l’actualisation du portefeuille en arrière-plan.',
    'module.broadcastComplete': 'Diffusion terminée avec {txid}.',
    'module.swapHandoff':
      'Échange en attente de visibilité : {txid}. Conservez l’identifiant et ne le renvoyez pas avant son apparition dans l’historique.',
    'module.swapBroadcastedMessage': 'Échange diffusé : {txid}',
    'module.swapFailed': 'Échec de l’échange',
    'module.cauldronSwapFailed': 'Échec de l’échange Cauldron',
    'module.pickTokenCreate':
      'Sélectionnez un token Cauldron avant de créer un pool.',
    'module.validPoolBch': 'Saisissez un montant de BCH valide pour le pool.',
    'module.validPoolToken':
      'Saisissez un montant de {symbol} valide pour le pool.',
    'module.noWalletAddress':
      'Aucune adresse de portefeuille disponible pour créer le pool.',
    'module.selectPool': 'Sélectionnez d’abord un pool.',
    'module.poolOwnerUnavailable':
      'Aucune adresse du portefeuille ne correspond au propriétaire de ce pool. Ce portefeuille ne peut pas le retirer.',
    'module.broadcastingPoolWithdrawal': 'Diffusion du retrait du pool',
    'module.preparingTransaction': 'Préparation de la transaction à envoyer.',
    'module.poolWithdrawalSubmitted': 'Retrait du pool envoyé',
    'module.poolWithdrawalBroadcasted': 'Retrait du pool diffusé',
    'module.poolWithdrawalMessage': 'Retrait du pool envoyé : {txid}',
    'module.unableWithdrawPool': 'Impossible de retirer le pool Cauldron',
    'module.broadcastingPoolCreation': 'Diffusion de la création du pool',
    'module.poolReviewMissingCategory':
      'La vérification du pool ne contient pas de catégorie de token.',
    'module.poolCreationSubmitted': 'Création du pool envoyée',
    'module.poolCreationBroadcasted': 'Création du pool diffusée',
    'module.poolSubmitted': 'Pool envoyé : {txid}',
    'module.poolBroadcastFailed': 'Échec de la diffusion du pool',
    'module.unableSubmitPool':
      'Impossible d’envoyer la transaction du pool Cauldron',
    'module.adjustedToRange': 'Ajusté à la plage.',
  },
  ko: {
    'module.errorLoadMarkets': 'Cauldron 시장을 불러오지 못했습니다',
    'module.errorLoadPools': 'Cauldron 풀을 불러오지 못했습니다',
    'module.marketRatio':
      '시장 비율: {bchAmount} BCH당 {tokenAmount} {symbol}.{adjustment}',
    'module.lpRefreshFailed':
      'LP 새로 고침에 실패했습니다. 캐시된 풀을 표시합니다.',
    'module.liveUpdateReceived':
      'Cauldron 풀의 실시간 업데이트를 받았습니다. 교환 전에 견적을 새로 고치세요.',
    'module.poolBchExceedsBalance':
      '풀 BCH 수량이 네트워크 수수료 여유분을 제외한 사용 가능 BCH 잔액을 초과합니다.',
    'module.poolTokenExceedsBalance':
      '풀 {symbol} 수량이 사용 가능한 토큰 잔액을 초과합니다.',
    'module.pickToken': '먼저 Cauldron 토큰을 선택하세요.',
    'module.validAmount': '0보다 큰 유효한 수량을 입력하세요.',
    'module.noActivePools': '이 토큰의 활성 Cauldron 풀을 찾지 못했습니다.',
    'module.minimumRouteAmount':
      '입력한 수량이 현재 라우팅 가능한 시장의 최소값보다 작습니다. 실행 가능한 경로를 만들려면 최소 {amount}이 필요합니다.',
    'module.marketChanged':
      '견적을 만들기 전에 체인의 표시된 Cauldron 시장이 변경되었습니다. 새로 고친 후 다시 시도하세요.',
    'module.noQuoteAvailable':
      '현재 해당 수량의 Cauldron 견적을 사용할 수 없습니다.',
    'module.noExecutableRoute':
      'Cauldron이 이 방향에서 실행 가능한 풀로 경로를 만들지 못했습니다. 새로 고친 후 다시 시도하세요.',
    'module.noSettlementAddress': '사용 가능한 지갑 정산 주소가 없습니다.',
    'module.routeComplex':
      '이 경로는 {count}개의 풀을 사용하며 일반적인 교환보다 복잡합니다.',
    'module.walletInputsWarning':
      '이 교환은 지갑 입력 {count}개를 사용합니다. 선택한 코인을 주의 깊게 확인하세요.',
    'module.slippageWarning':
      '슬리피지 설정이 {percent}%로, 지갑 확인 교환에는 높습니다.',
    'module.feeWarning':
      '예상 네트워크 수수료가 거래 규모에 비해 비교적 높습니다({percent}%).',
    'module.liquidityUsageWarning':
      '{label}이(가) 현재 실행 가능한 시장 깊이의 약 {percent}%를 사용합니다. 포지션을 종료하기 전에 유동성이 변할 수 있습니다.',
    'module.reverseTokenUnavailable':
      '현재 역방향 유동성을 사실상 사용할 수 없습니다. {amount}을(를) 받으면 유동성이 늘 때까지 BCH로 되돌려 교환하지 못할 수 있습니다.',
    'module.reverseTokenLimited':
      '현재 역방향 유동성은 약 {amount}만 흡수할 수 있습니다. 이 견적은 시장이 BCH로 되돌릴 수 있는 것보다 많은 {symbol}을 남깁니다.',
    'module.reverseBchUnavailable':
      '현재 BCH에서 {symbol}(으)로의 유동성을 사실상 사용할 수 없습니다. 지금 BCH로 나가면 유동성이 돌아올 때까지 다시 구매하지 못할 수 있습니다.',
    'module.reverseBchLimited':
      '현재 BCH에서 {symbol}(으)로의 유동성은 약 {amount}만 흡수할 수 있습니다. 이 견적의 BCH가 현재 {symbol}(으)로 라우팅할 수 있는 능력을 초과합니다.',
    'module.cachedPoolsWarning':
      '체인 확인이 속도 제한되어 이미 표시된 풀 집합으로 견적을 만들었습니다. 제출 전 체인 상태를 다시 확인합니다.',
    'module.unableToQuote': 'Cauldron 교환 견적을 만들지 못했습니다',
    'module.refreshQuote': '교환하기 전에 견적을 새로 고치세요.',
    'module.quoteExpiredChanged':
      '검토한 풀 중 하나 이상이 체인에서 변경되어 Cauldron 견적이 만료되었습니다. 새 견적을 받으세요.',
    'module.quoteExpiredState':
      '최신 확인된 풀 상태와 달라 Cauldron 견적이 만료되었습니다. 새로 고친 후 다시 시도하세요.',
    'module.routeRefreshFailed':
      'Cauldron이 이 방향에서 실행 가능한 풀로 경로를 새로 고치지 못했습니다.',
    'module.slippageLimit':
      '새로 고친 견적이 설정한 슬리피지 한도보다 낮습니다.',
    'module.freshQuoteReview': '이 교환을 검토하기 전에 새 견적을 받으세요.',
    'module.payReceive': '{payUnit} 지불, {receiveUnit} 수령',
    'module.swapSubmitted': '교환을 제출했습니다',
    'module.swapBroadcasted': '교환을 브로드캐스트했습니다',
    'module.transactionWatch':
      '지갑이 백그라운드에서 새로 고치는 동안 {txid}을(를) 추적합니다.',
    'module.broadcastComplete': '브로드캐스트 완료: {txid}.',
    'module.swapHandoff':
      '교환 표시 대기 중: {txid}. 기록에 나타날 때까지 ID를 보관하고 다시 보내지 마세요.',
    'module.swapBroadcastedMessage': '교환 브로드캐스트 완료: {txid}',
    'module.swapFailed': '교환 실패',
    'module.cauldronSwapFailed': 'Cauldron 교환 실패',
    'module.pickTokenCreate': '풀을 만들기 전에 Cauldron 토큰을 선택하세요.',
    'module.validPoolBch': '풀에 사용할 유효한 BCH 수량을 입력하세요.',
    'module.validPoolToken': '풀에 사용할 유효한 {symbol} 수량을 입력하세요.',
    'module.noWalletAddress': '풀을 만들 수 있는 지갑 주소가 없습니다.',
    'module.selectPool': '먼저 풀을 선택하세요.',
    'module.poolOwnerUnavailable':
      '이 풀 소유자와 일치하는 지갑 주소가 없습니다. 이 지갑에서는 인출할 수 없습니다.',
    'module.broadcastingPoolWithdrawal': '풀 인출을 브로드캐스트하는 중',
    'module.preparingTransaction': '제출할 거래를 준비하는 중입니다.',
    'module.poolWithdrawalSubmitted': '풀 인출을 제출했습니다',
    'module.poolWithdrawalBroadcasted': '풀 인출을 브로드캐스트했습니다',
    'module.poolWithdrawalMessage': '풀 인출 제출 완료: {txid}',
    'module.unableWithdrawPool': 'Cauldron 풀을 인출하지 못했습니다',
    'module.broadcastingPoolCreation': '풀 생성을 브로드캐스트하는 중',
    'module.poolReviewMissingCategory': '풀 검토에 토큰 카테고리가 없습니다.',
    'module.poolCreationSubmitted': '풀 생성을 제출했습니다',
    'module.poolCreationBroadcasted': '풀 생성을 브로드캐스트했습니다',
    'module.poolSubmitted': '풀 제출 완료: {txid}',
    'module.poolBroadcastFailed': '풀 브로드캐스트 실패',
    'module.unableSubmitPool': 'Cauldron 풀 거래를 제출하지 못했습니다',
    'module.adjustedToRange': '범위에 맞게 조정했습니다.',
  },
  ja: {
    'module.errorLoadMarkets': 'Cauldronの市場を読み込めませんでした',
    'module.errorLoadPools': 'Cauldronのプールを読み込めませんでした',
    'module.marketRatio':
      '市場比率：{bchAmount} BCH に対して {tokenAmount} {symbol}。{adjustment}',
    'module.lpRefreshFailed':
      'LPの更新に失敗しました。キャッシュ済みのプールを表示しています。',
    'module.liveUpdateReceived':
      'Cauldronプールのライブ更新を受信しました。交換前に見積もりを更新してください。',
    'module.poolBchExceedsBalance':
      'プールのBCH数量が、ネットワーク手数料の余裕分を除いた使用可能なBCH残高を超えています。',
    'module.poolTokenExceedsBalance':
      'プールの{symbol}数量が使用可能なトークン残高を超えています。',
    'module.pickToken': '先にCauldronトークンを選択してください。',
    'module.validAmount': '0より大きい有効な数量を入力してください。',
    'module.noActivePools':
      'このトークンの有効なCauldronプールが見つかりません。',
    'module.minimumRouteAmount':
      'その数量は現在ルーティング可能な市場の最小値を下回っています。実行可能なルートを作るには少なくとも{amount}が必要です。',
    'module.marketChanged':
      '見積もりを作成する前に、チェーン上の表示中のCauldron市場が変わりました。更新してもう一度お試しください。',
    'module.noQuoteAvailable':
      '現在、その数量のCauldron見積もりは利用できません。',
    'module.noExecutableRoute':
      'この方向で実行可能なプールを使ったルートをCauldronが作成できませんでした。更新してもう一度お試しください。',
    'module.noSettlementAddress':
      '利用可能なウォレット決済アドレスがありません。',
    'module.routeComplex':
      'このルートは{count}個のプールを使用し、通常の交換より複雑です。',
    'module.walletInputsWarning':
      'この交換ではウォレット入力を{count}個使用します。選択したコインをよく確認してください。',
    'module.slippageWarning':
      'スリッページ設定は{percent}%で、ウォレット確認の交換としては高めです。',
    'module.feeWarning':
      '推定ネットワーク手数料は、この取引額に対して比較的高額です（{percent}%）。',
    'module.liquidityUsageWarning':
      '{label}は現在実行可能な市場深度の約{percent}%を使用しています。ポジションを解消する前に流動性が変化する可能性があります。',
    'module.reverseTokenUnavailable':
      '現在、逆方向の流動性はほぼ利用できません。{amount}を受け取った場合、流動性が増えるまでBCHに戻せない可能性があります。',
    'module.reverseTokenLimited':
      '現在の逆方向の流動性が吸収できるのは約{amount}までです。この見積もりでは、市場がBCHへ戻せる量を超える{symbol}が残る可能性があります。',
    'module.reverseBchUnavailable':
      '現在、BCHから{symbol}への流動性はほぼ利用できません。今BCHへ戻ると、流動性が戻るまで買い戻せない可能性があります。',
    'module.reverseBchLimited':
      '現在、BCHから{symbol}への流動性が吸収できるのは約{amount}までです。この見積もりのBCHは{symbol}へ戻す現在のルート能力を超えます。',
    'module.cachedPoolsWarning':
      'チェーン確認がレート制限されたため、表示済みのプールを使って見積もりました。送信前にはチェーン状態を再確認します。',
    'module.unableToQuote': 'Cauldron交換の見積もりを作成できませんでした',
    'module.refreshQuote': '交換前に見積もりを更新してください。',
    'module.quoteExpiredChanged':
      '確認済みのプールがチェーン上で変更されたため、Cauldronの見積もりが期限切れになりました。新しい見積もりを取得してください。',
    'module.quoteExpiredState':
      '最新の確認済みプール状態と一致しないため、Cauldronの見積もりが期限切れになりました。更新してもう一度お試しください。',
    'module.routeRefreshFailed':
      'この方向で実行可能なプールを使ってCauldronのルートを更新できませんでした。',
    'module.slippageLimit':
      '更新後の見積もりが設定したスリッページ上限を下回りました。',
    'module.freshQuoteReview':
      'この交換を確認する前に新しい見積もりを取得してください。',
    'module.payReceive': '{payUnit}を支払い、{receiveUnit}を受け取る',
    'module.swapSubmitted': '交換を送信しました',
    'module.swapBroadcasted': '交換をブロードキャストしました',
    'module.transactionWatch':
      'ウォレットがバックグラウンドで更新する間、{txid}を監視します。',
    'module.broadcastComplete': 'ブロードキャスト完了：{txid}。',
    'module.swapHandoff':
      '交換の表示待ち：{txid}。履歴に表示されるまでIDを保管し、再送しないでください。',
    'module.swapBroadcastedMessage': '交換をブロードキャストしました：{txid}',
    'module.swapFailed': '交換に失敗しました',
    'module.cauldronSwapFailed': 'Cauldron交換に失敗しました',
    'module.pickTokenCreate':
      'プールを作成する前にCauldronトークンを選択してください。',
    'module.validPoolBch': 'プール用の有効なBCH数量を入力してください。',
    'module.validPoolToken': 'プール用の有効な{symbol}数量を入力してください。',
    'module.noWalletAddress':
      'プール作成に使用できるウォレットアドレスがありません。',
    'module.selectPool': '先にプールを選択してください。',
    'module.poolOwnerUnavailable':
      'このプール所有者に一致するウォレットアドレスがありません。このウォレットからは引き出せません。',
    'module.broadcastingPoolWithdrawal': 'プールの引き出しをブロードキャスト中',
    'module.preparingTransaction': '送信するトランザクションを準備しています。',
    'module.poolWithdrawalSubmitted': 'プールの引き出しを送信しました',
    'module.poolWithdrawalBroadcasted':
      'プールの引き出しをブロードキャストしました',
    'module.poolWithdrawalMessage': 'プールの引き出しを送信しました：{txid}',
    'module.unableWithdrawPool': 'Cauldronプールを引き出せませんでした',
    'module.broadcastingPoolCreation': 'プール作成をブロードキャスト中',
    'module.poolReviewMissingCategory':
      'プールの確認にトークンカテゴリがありません。',
    'module.poolCreationSubmitted': 'プール作成を送信しました',
    'module.poolCreationBroadcasted': 'プール作成をブロードキャストしました',
    'module.poolSubmitted': 'プールを送信しました：{txid}',
    'module.poolBroadcastFailed': 'プールのブロードキャストに失敗しました',
    'module.unableSubmitPool':
      'Cauldronプールのトランザクションを送信できませんでした',
    'module.adjustedToRange': '範囲内に調整しました。',
  },
  ru: {
    'module.errorLoadMarkets': 'Не удалось загрузить рынки Cauldron',
    'module.errorLoadPools': 'Не удалось загрузить пулы Cauldron',
    'module.marketRatio':
      'Рыночное соотношение: {tokenAmount} {symbol} за {bchAmount} BCH.{adjustment}',
    'module.lpRefreshFailed':
      'Не удалось обновить LP. Показываются кэшированные пулы.',
    'module.liveUpdateReceived':
      'Получено обновление пула Cauldron в реальном времени. Обновите котировку перед обменом.',
    'module.poolBchExceedsBalance':
      'Количество BCH в пуле превышает доступный баланс BCH после резерва комиссии сети.',
    'module.poolTokenExceedsBalance':
      'Количество {symbol} в пуле превышает доступный баланс токенов.',
    'module.pickToken': 'Сначала выберите токен Cauldron.',
    'module.validAmount': 'Введите допустимое количество больше нуля.',
    'module.noActivePools':
      'Для этого токена не найдено активных пулов Cauldron.',
    'module.minimumRouteAmount':
      'Количество ниже текущего минимального размера маршрута. Для исполняемого маршрута рынку нужно не менее {amount}.',
    'module.marketChanged':
      'Видимый рынок Cauldron изменился в блокчейне до создания этой котировки. Обновите и попробуйте снова.',
    'module.noQuoteAvailable':
      'Для этого количества сейчас нет котировки Cauldron.',
    'module.noExecutableRoute':
      'Cauldron не смог создать маршрут с исполняемыми пулами в этом направлении. Обновите и попробуйте снова.',
    'module.noSettlementAddress': 'Нет доступного расчётного адреса кошелька.',
    'module.routeComplex':
      'Этот маршрут использует {count} пулов и сложнее обычного обмена.',
    'module.walletInputsWarning':
      'Для обмена будут использованы {count} входов кошелька. Внимательно проверьте выбранные монеты.',
    'module.slippageWarning':
      'Установленное проскальзывание — {percent}%, что много для обмена с подтверждением кошелька.',
    'module.feeWarning':
      'Расчётная комиссия сети относительно велика для этой суммы ({percent}%).',
    'module.liquidityUsageWarning':
      '{label} использует около {percent}% текущей исполняемой глубины рынка. Ликвидность может измениться до выхода из позиции.',
    'module.reverseTokenUnavailable':
      'Обратная ликвидность практически недоступна. Получив {amount}, вы можете не суметь обменять его обратно на BCH до появления ликвидности.',
    'module.reverseTokenLimited':
      'Текущая обратная ликвидность может поглотить лишь около {amount}. После этой котировки останется больше {symbol}, чем рынок может обменять обратно на BCH.',
    'module.reverseBchUnavailable':
      'Текущая ликвидность BCH к {symbol} практически недоступна. При выходе в BCH сейчас обратная покупка может быть невозможна до восстановления ликвидности.',
    'module.reverseBchLimited':
      'Текущая ликвидность BCH к {symbol} может поглотить лишь около {amount}. BCH из этой котировки превышает текущую возможность маршрута к {symbol}.',
    'module.cachedPoolsWarning':
      'Подтверждение блокчейна ограничено, поэтому использован уже видимый набор пулов. Перед отправкой состояние блокчейна будет проверено снова.',
    'module.unableToQuote': 'Не удалось получить котировку обмена Cauldron',
    'module.refreshQuote': 'Обновите котировку перед обменом.',
    'module.quoteExpiredChanged':
      'Котировка Cauldron устарела: один или несколько проверенных пулов изменились в блокчейне. Получите новую котировку.',
    'module.quoteExpiredState':
      'Котировка Cauldron устарела относительно последнего подтверждённого состояния пула. Обновите и попробуйте снова.',
    'module.routeRefreshFailed':
      'Cauldron не смог обновить маршрут с исполняемыми пулами в этом направлении.',
    'module.slippageLimit':
      'Обновлённая котировка ниже установленного ограничения проскальзывания.',
    'module.freshQuoteReview':
      'Получите новую котировку перед проверкой этого обмена.',
    'module.payReceive': 'Заплатить {payUnit}, получить {receiveUnit}',
    'module.swapSubmitted': 'Обмен отправлен',
    'module.swapBroadcasted': 'Обмен транслирован',
    'module.transactionWatch':
      'Отслеживаем {txid}, пока кошелёк обновляется в фоне.',
    'module.broadcastComplete': 'Трансляция завершена: {txid}.',
    'module.swapHandoff':
      'Обмен ожидает отображения: {txid}. Сохраните ID и не отправляйте его снова до появления в истории.',
    'module.swapBroadcastedMessage': 'Обмен транслирован: {txid}',
    'module.swapFailed': 'Обмен не выполнен',
    'module.cauldronSwapFailed': 'Обмен Cauldron не выполнен',
    'module.pickTokenCreate': 'Выберите токен Cauldron перед созданием пула.',
    'module.validPoolBch': 'Введите допустимое количество BCH для пула.',
    'module.validPoolToken': 'Введите допустимое количество {symbol} для пула.',
    'module.noWalletAddress': 'Нет адреса кошелька для создания пула.',
    'module.selectPool': 'Сначала выберите пул.',
    'module.poolOwnerUnavailable':
      'Адрес кошелька не соответствует владельцу этого пула. Из этого кошелька вывести средства нельзя.',
    'module.broadcastingPoolWithdrawal': 'Трансляция вывода из пула',
    'module.preparingTransaction': 'Подготовка транзакции к отправке.',
    'module.poolWithdrawalSubmitted': 'Вывод из пула отправлен',
    'module.poolWithdrawalBroadcasted': 'Вывод из пула транслирован',
    'module.poolWithdrawalMessage': 'Вывод из пула отправлен: {txid}',
    'module.unableWithdrawPool': 'Не удалось вывести средства из пула Cauldron',
    'module.broadcastingPoolCreation': 'Трансляция создания пула',
    'module.poolReviewMissingCategory':
      'В проверке пула отсутствует категория токена.',
    'module.poolCreationSubmitted': 'Создание пула отправлено',
    'module.poolCreationBroadcasted': 'Создание пула транслировано',
    'module.poolSubmitted': 'Пул отправлен: {txid}',
    'module.poolBroadcastFailed': 'Не удалось транслировать пул',
    'module.unableSubmitPool': 'Не удалось отправить транзакцию пула Cauldron',
    'module.adjustedToRange': 'Скорректировано до диапазона.',
  },
  'ha-NG': {
    'module.errorLoadMarkets': 'An kasa loda kasuwannin Cauldron',
    'module.errorLoadPools': 'An kasa loda wuraren Cauldron',
    'module.marketRatio':
      'Rabon kasuwa: {tokenAmount} {symbol} ga {bchAmount} BCH.{adjustment}',
    'module.lpRefreshFailed':
      'Sabunta LP ta gaza. Ana nuna wuraren da aka ajiye.',
    'module.liveUpdateReceived':
      'An sami sabuntawar wurin Cauldron kai tsaye. Sabunta ƙididdigar kafin musayar.',
    'module.poolBchExceedsBalance':
      'Adadin BCH na wurin ya wuce BCH da za ka iya kashewa bayan ajiyar kuɗin hanyar sadarwa.',
    'module.poolTokenExceedsBalance':
      'Adadin {symbol} na wurin ya wuce token da ke cikin ma’aunin ka.',
    'module.pickToken': 'Da farko zaɓi token na Cauldron.',
    'module.validAmount': 'Shigar da adadi mai inganci wanda ya fi sifili.',
    'module.noActivePools':
      'Ba a sami wuraren Cauldron masu aiki na wannan token ba.',
    'module.minimumRouteAmount':
      'Adadin ya kasa ƙaramin girman kasuwar da za a iya bi yanzu. Kasuwar na buƙatar aƙalla {amount} don gina hanyar da za a aiwatar.',
    'module.marketChanged':
      'Kasuwar Cauldron da ake gani ta canza a kan sarka kafin a gina wannan ƙididdiga. Sabunta sannan a sake gwadawa.',
    'module.noQuoteAvailable':
      'Babu ƙididdigar Cauldron da ke samuwa yanzu don wannan adadi.',
    'module.noExecutableRoute':
      'Cauldron bai iya gina hanya da wuraren da za a aiwatar ba a wannan hanya. Sabunta sannan a sake gwadawa.',
    'module.noSettlementAddress':
      'Babu adireshin daidaita wallet da ke samuwa.',
    'module.routeComplex':
      'Wannan hanya tana amfani da wurare {count}, kuma ta fi musayar yau da kullum rikitarwa.',
    'module.walletInputsWarning':
      'Wannan musayar za ta kashe abubuwan shigar wallet {count}. Duba tsabar da aka zaɓa sosai.',
    'module.slippageWarning':
      'Saitin slippage ɗinka {percent}%, ya yi yawa ga musayar da wallet ya tabbatar.',
    'module.feeWarning':
      'Kudin hanyar sadarwa da aka kiyasta ya yi yawa ga girman wannan ciniki ({percent}%).',
    'module.liquidityUsageWarning':
      '{label} yana amfani da kusan {percent}% na zurfin kasuwar da za a aiwatar yanzu. Liquidity na iya canzawa kafin ka rufe wannan matsayi.',
    'module.reverseTokenUnavailable':
      'Liquidity na juyawa yanzu ba ya samuwa sosai. Idan ka karɓi {amount}, ƙila ba za ka iya mayar da shi BCH ba sai liquidity ta ƙaru.',
    'module.reverseTokenLimited':
      'Liquidity na juyawa yanzu na iya ɗaukar kusan {amount} kawai. Wannan ƙididdiga za ta bar maka {symbol} fiye da abin da kasuwa za ta iya mayarwa BCH.',
    'module.reverseBchUnavailable':
      'Liquidity daga BCH zuwa {symbol} ba ta samuwa sosai yanzu. Idan ka koma BCH yanzu, ƙila ba za ka iya saya ba sai liquidity ta dawo.',
    'module.reverseBchLimited':
      'Liquidity daga BCH zuwa {symbol} na iya ɗaukar kusan {amount} kawai. BCH na wannan ƙididdiga ya wuce ikon hanyar kasuwa zuwa {symbol} yanzu.',
    'module.cachedPoolsWarning':
      'An takaita tabbatar da sarka, saboda haka ƙididdigar ta yi amfani da wuraren da ake gani. Za a sake duba yanayin sarka kafin aikawa.',
    'module.unableToQuote': 'An kasa samun ƙididdigar musayar Cauldron',
    'module.refreshQuote': 'Sabunta ƙididdigar kafin musayar.',
    'module.quoteExpiredChanged':
      'Ƙididdigar Cauldron ta ƙare saboda wurare ɗaya ko fiye da aka duba sun canza a kan sarka. Sami sabuwar ƙididdiga.',
    'module.quoteExpiredState':
      'Ƙididdigar Cauldron ta ƙare saboda ba ta dace da sabon yanayin wurin da aka tabbatar ba. Sabunta sannan a sake gwadawa.',
    'module.routeRefreshFailed':
      'Cauldron bai iya sabunta wannan hanya da wuraren da za a aiwatar ba a wannan hanya.',
    'module.slippageLimit': 'Sabuwar ƙididdiga ta kasa iyakar slippage ɗinka.',
    'module.freshQuoteReview':
      'Sami sabuwar ƙididdiga kafin duba wannan musayar.',
    'module.payReceive': 'Biya {payUnit}, karɓi {receiveUnit}',
    'module.swapSubmitted': 'An aika musayar',
    'module.swapBroadcasted': 'An watsa musayar',
    'module.transactionWatch':
      'Ana sa ido kan {txid} yayin da wallet ke sabuntawa a bango.',
    'module.broadcastComplete': 'An kammala watsawa da {txid}.',
    'module.swapHandoff':
      'Musayar na jiran bayyana: {txid}. Riƙe ID ɗin, kada ka sake aikawa har sai ya bayyana a tarihi.',
    'module.swapBroadcastedMessage': 'An watsa musayar: {txid}',
    'module.swapFailed': 'Musayar ta gaza',
    'module.cauldronSwapFailed': 'Musayar Cauldron ta gaza',
    'module.pickTokenCreate': 'Zaɓi token na Cauldron kafin ƙirƙirar wuri.',
    'module.validPoolBch': 'Shigar da ingantaccen adadin BCH na wurin.',
    'module.validPoolToken': 'Shigar da ingantaccen adadin {symbol} na wurin.',
    'module.noWalletAddress': 'Babu adireshin wallet don ƙirƙirar wuri.',
    'module.selectPool': 'Da farko zaɓi wuri.',
    'module.poolOwnerUnavailable':
      'Babu adireshin wallet da ya dace da mai wannan wuri. Ba za a iya cirewa daga wannan wallet ba.',
    'module.broadcastingPoolWithdrawal': 'Ana watsa cirewa daga wuri',
    'module.preparingTransaction': 'Ana shirya ciniki don aikawa.',
    'module.poolWithdrawalSubmitted': 'An aika cirewa daga wuri',
    'module.poolWithdrawalBroadcasted': 'An watsa cirewa daga wuri',
    'module.poolWithdrawalMessage': 'An aika cirewa daga wuri: {txid}',
    'module.unableWithdrawPool': 'An kasa cirewa daga wurin Cauldron',
    'module.broadcastingPoolCreation': 'Ana watsa ƙirƙirar wuri',
    'module.poolReviewMissingCategory': 'Bita na wurin ba ta da rukunin token.',
    'module.poolCreationSubmitted': 'An aika ƙirƙirar wuri',
    'module.poolCreationBroadcasted': 'An watsa ƙirƙirar wuri',
    'module.poolSubmitted': 'An aika wuri: {txid}',
    'module.poolBroadcastFailed': 'Watsa wurin ya gaza',
    'module.unableSubmitPool': 'An kasa aika cinikin wurin Cauldron',
    'module.adjustedToRange': 'An daidaita zuwa iyaka.',
  },
};

const liquidityLabelMessages: AddonModuleLocaleMessages = {
  en: {
    'module.wallet': 'Wallet',
    'module.buy': 'This buy',
    'module.sell': 'This sell',
    'module.sellingBack': 'Selling back {amount}',
    'module.buyingBack': 'Buying back with {amount}',
  },
  es: {
    'module.wallet': 'Cartera',
    'module.buy': 'Esta compra',
    'module.sell': 'Esta venta',
    'module.sellingBack': 'Vender de nuevo {amount}',
    'module.buyingBack': 'Volver a comprar con {amount}',
  },
  'pt-BR': {
    'module.wallet': 'Carteira',
    'module.buy': 'Esta compra',
    'module.sell': 'Esta venda',
    'module.sellingBack': 'Vendendo novamente {amount}',
    'module.buyingBack': 'Comprando novamente com {amount}',
  },
  'zh-CN': {
    'module.wallet': '钱包',
    'module.buy': '此次买入',
    'module.sell': '此次卖出',
    'module.sellingBack': '卖回 {amount}',
    'module.buyingBack': '用 {amount} 买回',
  },
  'zh-TW': {
    'module.wallet': '錢包',
    'module.buy': '此次買入',
    'module.sell': '此次賣出',
    'module.sellingBack': '賣回 {amount}',
    'module.buyingBack': '用 {amount} 買回',
  },
  vi: {
    'module.wallet': 'Ví',
    'module.buy': 'Lần mua này',
    'module.sell': 'Lần bán này',
    'module.sellingBack': 'Bán ngược lại {amount}',
    'module.buyingBack': 'Mua lại bằng {amount}',
  },
  ar: {
    'module.wallet': 'المحفظة',
    'module.buy': 'عملية الشراء هذه',
    'module.sell': 'عملية البيع هذه',
    'module.sellingBack': 'البيع مجددًا بقيمة {amount}',
    'module.buyingBack': 'الشراء مجددًا باستخدام {amount}',
  },
  fr: {
    'module.wallet': 'Portefeuille',
    'module.buy': 'Cet achat',
    'module.sell': 'Cette vente',
    'module.sellingBack': 'Revente de {amount}',
    'module.buyingBack': 'Rachat avec {amount}',
  },
  ko: {
    'module.wallet': '지갑',
    'module.buy': '이번 매수',
    'module.sell': '이번 매도',
    'module.sellingBack': '{amount} 되팔기',
    'module.buyingBack': '{amount}(으)로 다시 매수',
  },
  ja: {
    'module.wallet': 'ウォレット',
    'module.buy': '今回の買い',
    'module.sell': '今回の売り',
    'module.sellingBack': '{amount}を売り戻す',
    'module.buyingBack': '{amount}で買い戻す',
  },
  ru: {
    'module.wallet': 'Кошелёк',
    'module.buy': 'Эта покупка',
    'module.sell': 'Эта продажа',
    'module.sellingBack': 'Продажа обратно: {amount}',
    'module.buyingBack': 'Покупка обратно за {amount}',
  },
  'ha-NG': {
    'module.wallet': 'Wallet',
    'module.buy': 'Wannan saye',
    'module.sell': 'Wannan sayarwa',
    'module.sellingBack': 'Sayarwa baya {amount}',
    'module.buyingBack': 'Saye baya da {amount}',
  },
};

const auxiliaryMessages: AddonModuleLocaleMessages = {
  en: {
    'module.errorPreviewMarket': 'Unable to preview Cauldron market',
    'module.unableCreatePool': 'Unable to create Cauldron pool',
    'module.unableBroadcastPool': 'Unable to broadcast pool',
  },
  es: {
    'module.errorPreviewMarket':
      'No se pudo previsualizar el mercado de Cauldron',
    'module.unableCreatePool': 'No se pudo crear el pool de Cauldron',
    'module.unableBroadcastPool': 'No se pudo difundir el pool',
  },
  'pt-BR': {
    'module.errorPreviewMarket':
      'Não foi possível visualizar o mercado do Cauldron',
    'module.unableCreatePool': 'Não foi possível criar o pool do Cauldron',
    'module.unableBroadcastPool': 'Não foi possível transmitir o pool',
  },
  'zh-CN': {
    'module.errorPreviewMarket': '无法预览 Cauldron 市场',
    'module.unableCreatePool': '无法创建 Cauldron 池',
    'module.unableBroadcastPool': '无法广播池交易',
  },
  'zh-TW': {
    'module.errorPreviewMarket': '無法預覽 Cauldron 市場',
    'module.unableCreatePool': '無法建立 Cauldron 池',
    'module.unableBroadcastPool': '無法廣播池交易',
  },
  vi: {
    'module.errorPreviewMarket': 'Không thể xem trước thị trường Cauldron',
    'module.unableCreatePool': 'Không thể tạo pool Cauldron',
    'module.unableBroadcastPool': 'Không thể phát pool',
  },
  ar: {
    'module.errorPreviewMarket': 'تعذر معاينة سوق Cauldron',
    'module.unableCreatePool': 'تعذر إنشاء مجمع Cauldron',
    'module.unableBroadcastPool': 'تعذر بث المجمع',
  },
  fr: {
    'module.errorPreviewMarket':
      'Impossible de prévisualiser le marché Cauldron',
    'module.unableCreatePool': 'Impossible de créer le pool Cauldron',
    'module.unableBroadcastPool': 'Impossible de diffuser le pool',
  },
  ko: {
    'module.errorPreviewMarket': 'Cauldron 시장을 미리 보지 못했습니다',
    'module.unableCreatePool': 'Cauldron 풀을 만들지 못했습니다',
    'module.unableBroadcastPool': '풀을 브로드캐스트하지 못했습니다',
  },
  ja: {
    'module.errorPreviewMarket': 'Cauldron市場をプレビューできませんでした',
    'module.unableCreatePool': 'Cauldronプールを作成できませんでした',
    'module.unableBroadcastPool': 'プールをブロードキャストできませんでした',
  },
  ru: {
    'module.errorPreviewMarket': 'Не удалось просмотреть рынок Cauldron',
    'module.unableCreatePool': 'Не удалось создать пул Cauldron',
    'module.unableBroadcastPool': 'Не удалось транслировать пул',
  },
  'ha-NG': {
    'module.errorPreviewMarket': 'An kasa duba kasuwar Cauldron',
    'module.unableCreatePool': 'An kasa ƙirƙirar wurin Cauldron',
    'module.unableBroadcastPool': 'An kasa watsa wurin',
  },
};

const safetyMessages: AddonModuleLocaleMessages = {
  en: {
    'module.liveUpdatesUnavailable':
      'Live pool updates are unavailable right now, so this quote should be refreshed before confirming.',
    'module.cachedPoolSet':
      'This quote used the already-visible pool set because live pool confirmation was rate-limited.',
    'module.marketChangedAfterQuote':
      'The market changed after this quote was built. Refresh the quote before confirming.',
    'module.quoteAge':
      'This quote is {seconds}s old. Refresh it before confirming.',
    'module.quoteMayBeStale': 'Quote may be stale',
    'module.reviewQuoteRisks': 'Review quote risks',
  },
  es: {
    'module.liveUpdatesUnavailable':
      'Las actualizaciones en vivo de los pools no están disponibles; actualiza esta cotización antes de confirmar.',
    'module.cachedPoolSet':
      'Esta cotización usó los pools visibles porque la confirmación en vivo fue limitada.',
    'module.marketChangedAfterQuote':
      'El mercado cambió después de crear esta cotización. Actualízala antes de confirmar.',
    'module.quoteAge':
      'Esta cotización tiene {seconds} s. Actualízala antes de confirmar.',
    'module.quoteMayBeStale': 'La cotización puede estar desactualizada',
    'module.reviewQuoteRisks': 'Revisar riesgos de la cotización',
  },
  'pt-BR': {
    'module.liveUpdatesUnavailable':
      'As atualizações ao vivo dos pools não estão disponíveis; atualize esta cotação antes de confirmar.',
    'module.cachedPoolSet':
      'Esta cotação usou os pools visíveis porque a confirmação ao vivo sofreu limitação.',
    'module.marketChangedAfterQuote':
      'O mercado mudou depois que esta cotação foi criada. Atualize-a antes de confirmar.',
    'module.quoteAge':
      'Esta cotação tem {seconds}s. Atualize-a antes de confirmar.',
    'module.quoteMayBeStale': 'A cotação pode estar desatualizada',
    'module.reviewQuoteRisks': 'Revisar riscos da cotação',
  },
  'zh-CN': {
    'module.liveUpdatesUnavailable':
      '实时池更新目前不可用，因此确认前应刷新此报价。',
    'module.cachedPoolSet':
      '由于实时池确认受到速率限制，此报价使用了当前可见的池。',
    'module.marketChangedAfterQuote':
      '报价建立后市场发生了变化。确认前请刷新报价。',
    'module.quoteAge': '此报价已有 {seconds} 秒。确认前请刷新。',
    'module.quoteMayBeStale': '报价可能已过期',
    'module.reviewQuoteRisks': '查看报价风险',
  },
  'zh-TW': {
    'module.liveUpdatesUnavailable':
      '即時池更新目前無法使用，因此確認前應重新整理此報價。',
    'module.cachedPoolSet':
      '由於即時池確認受到速率限制，此報價使用了目前可見的池。',
    'module.marketChangedAfterQuote':
      '建立報價後市場發生了變更。確認前請重新整理報價。',
    'module.quoteAge': '此報價已有 {seconds} 秒。確認前請重新整理。',
    'module.quoteMayBeStale': '報價可能已過期',
    'module.reviewQuoteRisks': '檢視報價風險',
  },
  vi: {
    'module.liveUpdatesUnavailable':
      'Cập nhật pool trực tiếp hiện không khả dụng, vì vậy hãy làm mới báo giá trước khi xác nhận.',
    'module.cachedPoolSet':
      'Báo giá này dùng tập pool đang hiển thị vì xác nhận pool trực tiếp bị giới hạn.',
    'module.marketChangedAfterQuote':
      'Thị trường đã thay đổi sau khi tạo báo giá. Hãy làm mới trước khi xác nhận.',
    'module.quoteAge':
      'Báo giá này đã {seconds} giây. Hãy làm mới trước khi xác nhận.',
    'module.quoteMayBeStale': 'Báo giá có thể đã cũ',
    'module.reviewQuoteRisks': 'Xem lại rủi ro báo giá',
  },
  ar: {
    'module.liveUpdatesUnavailable':
      'تحديثات المجمع المباشرة غير متاحة حاليًا، لذا يجب تحديث العرض قبل التأكيد.',
    'module.cachedPoolSet':
      'استخدم هذا العرض مجموعة المجمعات الظاهرة لأن تأكيد المجمع المباشر كان محدودًا.',
    'module.marketChangedAfterQuote':
      'تغيّر السوق بعد إنشاء هذا العرض. حدّث العرض قبل التأكيد.',
    'module.quoteAge': 'يبلغ عمر هذا العرض {seconds} ثانية. حدّثه قبل التأكيد.',
    'module.quoteMayBeStale': 'قد يكون العرض قديمًا',
    'module.reviewQuoteRisks': 'مراجعة مخاطر العرض',
  },
  fr: {
    'module.liveUpdatesUnavailable':
      'Les mises à jour en direct des pools sont indisponibles ; actualisez ce devis avant confirmation.',
    'module.cachedPoolSet':
      'Ce devis utilise les pools visibles car la confirmation en direct a été limitée.',
    'module.marketChangedAfterQuote':
      'Le marché a changé après la création de ce devis. Actualisez-le avant confirmation.',
    'module.quoteAge':
      'Ce devis date de {seconds} s. Actualisez-le avant confirmation.',
    'module.quoteMayBeStale': 'Le devis peut être obsolète',
    'module.reviewQuoteRisks': 'Vérifier les risques du devis',
  },
  ko: {
    'module.liveUpdatesUnavailable':
      '현재 실시간 풀 업데이트를 사용할 수 없으므로 확인 전에 이 견적을 새로 고치세요.',
    'module.cachedPoolSet':
      '실시간 풀 확인이 속도 제한되어 이 견적은 표시된 풀 집합을 사용했습니다.',
    'module.marketChangedAfterQuote':
      '견적을 만든 후 시장이 변경되었습니다. 확인 전에 견적을 새로 고치세요.',
    'module.quoteAge':
      '이 견적은 {seconds}초 전의 것입니다. 확인 전에 새로 고치세요.',
    'module.quoteMayBeStale': '견적이 오래되었을 수 있습니다',
    'module.reviewQuoteRisks': '견적 위험 검토',
  },
  ja: {
    'module.liveUpdatesUnavailable':
      '現在ライブのプール更新を利用できないため、確認前にこの見積もりを更新してください。',
    'module.cachedPoolSet':
      'ライブのプール確認がレート制限されたため、この見積もりでは表示済みのプールを使用しました。',
    'module.marketChangedAfterQuote':
      '見積もり作成後に市場が変化しました。確認前に見積もりを更新してください。',
    'module.quoteAge':
      'この見積もりは{seconds}秒前のものです。確認前に更新してください。',
    'module.quoteMayBeStale': '見積もりが古い可能性があります',
    'module.reviewQuoteRisks': '見積もりのリスクを確認',
  },
  ru: {
    'module.liveUpdatesUnavailable':
      'Обновления пулов в реальном времени сейчас недоступны, поэтому обновите котировку перед подтверждением.',
    'module.cachedPoolSet':
      'Котировка использует видимый набор пулов, поскольку подтверждение в реальном времени ограничено.',
    'module.marketChangedAfterQuote':
      'После создания котировки рынок изменился. Обновите котировку перед подтверждением.',
    'module.quoteAge':
      'Котировке {seconds} с. Обновите её перед подтверждением.',
    'module.quoteMayBeStale': 'Котировка может быть устаревшей',
    'module.reviewQuoteRisks': 'Проверить риски котировки',
  },
  'ha-NG': {
    'module.liveUpdatesUnavailable':
      'Sabuntawar wurare kai tsaye ba ta samuwa yanzu, saboda haka sabunta ƙididdigar kafin tabbatarwa.',
    'module.cachedPoolSet':
      'Wannan ƙididdiga ta yi amfani da wuraren da ake gani saboda an takaita tabbatarwa kai tsaye.',
    'module.marketChangedAfterQuote':
      'Kasuwar ta canza bayan an gina wannan ƙididdiga. Sabunta kafin tabbatarwa.',
    'module.quoteAge':
      'Wannan ƙididdiga tana da shekaru {seconds}s. Sabunta ta kafin tabbatarwa.',
    'module.quoteMayBeStale': 'Ƙididdigar na iya zama tsohuwa',
    'module.reviewQuoteRisks': 'Duba haɗurran ƙididdiga',
  },
};

const preflightMessages: AddonModuleLocaleMessages = {
  en: {
    'module.staleWalletInputs':
      '{operation} needs refreshed wallet inputs. One or more selected UTXOs are no longer spendable.',
    'module.poolCreationOperation': 'Cauldron pool creation',
    'module.poolWithdrawalOperation': 'Cauldron pool withdrawal',
  },
  es: {
    'module.staleWalletInputs':
      '{operation} necesita entradas de cartera actualizadas. Una o más UTXO seleccionadas ya no se pueden gastar.',
    'module.poolCreationOperation': 'Creación de pool de Cauldron',
    'module.poolWithdrawalOperation': 'Retiro de pool de Cauldron',
  },
  'pt-BR': {
    'module.staleWalletInputs':
      '{operation} precisa de entradas atualizadas da carteira. Uma ou mais UTXOs selecionadas não estão mais disponíveis para gasto.',
    'module.poolCreationOperation': 'Criação de pool do Cauldron',
    'module.poolWithdrawalOperation': 'Saque de pool do Cauldron',
  },
  'zh-CN': {
    'module.staleWalletInputs':
      '{operation}需要刷新钱包输入。一个或多个所选 UTXO 已无法使用。',
    'module.poolCreationOperation': '创建 Cauldron 池',
    'module.poolWithdrawalOperation': '提取 Cauldron 池',
  },
  'zh-TW': {
    'module.staleWalletInputs':
      '{operation}需要重新整理錢包輸入。一個或多個所選 UTXO 已無法使用。',
    'module.poolCreationOperation': '建立 Cauldron 池',
    'module.poolWithdrawalOperation': '提取 Cauldron 池',
  },
  vi: {
    'module.staleWalletInputs':
      '{operation} cần làm mới đầu vào ví. Một hoặc nhiều UTXO đã chọn không còn có thể chi tiêu.',
    'module.poolCreationOperation': 'Tạo pool Cauldron',
    'module.poolWithdrawalOperation': 'Rút khỏi pool Cauldron',
  },
  ar: {
    'module.staleWalletInputs':
      'يحتاج {operation} إلى تحديث مدخلات المحفظة. لم يعد من الممكن إنفاق UTXO محدد واحد أو أكثر.',
    'module.poolCreationOperation': 'إنشاء مجمع Cauldron',
    'module.poolWithdrawalOperation': 'سحب من مجمع Cauldron',
  },
  fr: {
    'module.staleWalletInputs':
      '{operation} nécessite des entrées de portefeuille actualisées. Un ou plusieurs UTXO sélectionnés ne sont plus dépensables.',
    'module.poolCreationOperation': 'Création du pool Cauldron',
    'module.poolWithdrawalOperation': 'Retrait du pool Cauldron',
  },
  ko: {
    'module.staleWalletInputs':
      '{operation}에 지갑 입력을 새로 고쳐야 합니다. 선택한 UTXO 중 하나 이상을 더 이상 사용할 수 없습니다.',
    'module.poolCreationOperation': 'Cauldron 풀 생성',
    'module.poolWithdrawalOperation': 'Cauldron 풀 인출',
  },
  ja: {
    'module.staleWalletInputs':
      '{operation}にはウォレット入力の更新が必要です。選択したUTXOの1つ以上が使用できなくなっています。',
    'module.poolCreationOperation': 'Cauldronプールの作成',
    'module.poolWithdrawalOperation': 'Cauldronプールの引き出し',
  },
  ru: {
    'module.staleWalletInputs':
      'Для операции «{operation}» нужны обновлённые входы кошелька. Один или несколько выбранных UTXO больше нельзя потратить.',
    'module.poolCreationOperation': 'Создание пула Cauldron',
    'module.poolWithdrawalOperation': 'Вывод из пула Cauldron',
  },
  'ha-NG': {
    'module.staleWalletInputs':
      '{operation} na buƙatar sabunta abubuwan shigar wallet. Ba za a iya kashe UTXO ɗaya ko fiye da aka zaɓa ba.',
    'module.poolCreationOperation': 'Ƙirƙirar wurin Cauldron',
    'module.poolWithdrawalOperation': 'Cirewa daga wurin Cauldron',
  },
};

const fundingMessages: AddonModuleLocaleMessages = {
  en: {
    'module.insufficientBchUtxos':
      'Not enough BCH UTXOs are available for this swap.',
    'module.insufficientSwapTokenUtxos':
      'Not enough token UTXOs are available for this swap. Available {available} atoms across {count} UTXOs.',
    'module.insufficientFeeBacking':
      'Not enough BCH value is attached to token funding inputs to cover network fees.',
    'module.insufficientPoolTokenUtxos':
      'Not enough token UTXOs are available for this pool. Available {available} atoms across {count} UTXOs.',
    'module.insufficientPoolBch':
      'Not enough BCH is available to create this pool.',
    'module.ownerBchFundingMissing':
      'No BCH funding UTXO was found for the pool owner address ({address}).',
  },
  es: {
    'module.insufficientBchUtxos':
      'No hay suficientes UTXO de BCH disponibles para este intercambio.',
    'module.insufficientSwapTokenUtxos':
      'No hay suficientes UTXO de tokens para este intercambio. Disponibles {available} átomos en {count} UTXO.',
    'module.insufficientFeeBacking':
      'El valor BCH adjunto a las entradas de tokens no alcanza para cubrir las comisiones de red.',
    'module.insufficientPoolTokenUtxos':
      'No hay suficientes UTXO de tokens para este pool. Disponibles {available} átomos en {count} UTXO.',
    'module.insufficientPoolBch': 'No hay suficiente BCH para crear este pool.',
    'module.ownerBchFundingMissing':
      'No se encontró una UTXO de BCH para la dirección propietaria del pool ({address}).',
  },
  'pt-BR': {
    'module.insufficientBchUtxos':
      'Não há UTXOs de BCH suficientes disponíveis para esta troca.',
    'module.insufficientSwapTokenUtxos':
      'Não há UTXOs de tokens suficientes para esta troca. Disponíveis {available} átomos em {count} UTXOs.',
    'module.insufficientFeeBacking':
      'O valor de BCH anexado às entradas de tokens não é suficiente para cobrir as taxas de rede.',
    'module.insufficientPoolTokenUtxos':
      'Não há UTXOs de tokens suficientes para este pool. Disponíveis {available} átomos em {count} UTXOs.',
    'module.insufficientPoolBch': 'Não há BCH suficiente para criar este pool.',
    'module.ownerBchFundingMissing':
      'Nenhuma UTXO de BCH foi encontrada para o endereço proprietário do pool ({address}).',
  },
  'zh-CN': {
    'module.insufficientBchUtxos': '没有足够的 BCH UTXO 可用于此次兑换。',
    'module.insufficientSwapTokenUtxos':
      '没有足够的代币 UTXO 可用于此次兑换。{count} 个 UTXO 中共有 {available} 个原子单位可用。',
    'module.insufficientFeeBacking':
      '代币资金输入附带的 BCH 不足以支付网络费。',
    'module.insufficientPoolTokenUtxos':
      '没有足够的代币 UTXO 可用于此池。{count} 个 UTXO 中共有 {available} 个原子单位可用。',
    'module.insufficientPoolBch': '没有足够的 BCH 创建此池。',
    'module.ownerBchFundingMissing':
      '未找到池所有者地址（{address}）对应的 BCH 资金 UTXO。',
  },
  'zh-TW': {
    'module.insufficientBchUtxos': '沒有足夠的 BCH UTXO 可用於此次兌換。',
    'module.insufficientSwapTokenUtxos':
      '沒有足夠的代幣 UTXO 可用於此次兌換。{count} 個 UTXO 中共有 {available} 個原子單位可用。',
    'module.insufficientFeeBacking':
      '代幣資金輸入附帶的 BCH 不足以支付網路費。',
    'module.insufficientPoolTokenUtxos':
      '沒有足夠的代幣 UTXO 可用於此池。{count} 個 UTXO 中共有 {available} 個原子單位可用。',
    'module.insufficientPoolBch': '沒有足夠的 BCH 建立此池。',
    'module.ownerBchFundingMissing':
      '找不到池擁有者地址（{address}）對應的 BCH 資金 UTXO。',
  },
  vi: {
    'module.insufficientBchUtxos':
      'Không đủ UTXO BCH để thực hiện hoán đổi này.',
    'module.insufficientSwapTokenUtxos':
      'Không đủ UTXO token cho lần hoán đổi này. Có {available} đơn vị nguyên tử trong {count} UTXO.',
    'module.insufficientFeeBacking':
      'Giá trị BCH đi kèm đầu vào cấp vốn token không đủ để trả phí mạng.',
    'module.insufficientPoolTokenUtxos':
      'Không đủ UTXO token cho pool này. Có {available} đơn vị nguyên tử trong {count} UTXO.',
    'module.insufficientPoolBch': 'Không đủ BCH để tạo pool này.',
    'module.ownerBchFundingMissing':
      'Không tìm thấy UTXO BCH cấp vốn cho địa chỉ chủ pool ({address}).',
  },
  ar: {
    'module.insufficientBchUtxos': 'لا تتوفر UTXO كافية من BCH لهذه المبادلة.',
    'module.insufficientSwapTokenUtxos':
      'لا تتوفر UTXO رموز كافية لهذه المبادلة. المتاح {available} وحدة ذرية عبر {count} من UTXO.',
    'module.insufficientFeeBacking':
      'قيمة BCH المرفقة بمدخلات تمويل الرمز غير كافية لتغطية رسوم الشبكة.',
    'module.insufficientPoolTokenUtxos':
      'لا تتوفر UTXO رموز كافية لهذا المجمع. المتاح {available} وحدة ذرية عبر {count} من UTXO.',
    'module.insufficientPoolBch': 'لا تتوفر BCH كافية لإنشاء هذا المجمع.',
    'module.ownerBchFundingMissing':
      'لم يتم العثور على UTXO تمويل BCH لعنوان مالك المجمع ({address}).',
  },
  fr: {
    'module.insufficientBchUtxos':
      'Il n’y a pas assez d’UTXO BCH disponibles pour cet échange.',
    'module.insufficientSwapTokenUtxos':
      'Il n’y a pas assez d’UTXO de tokens pour cet échange. {available} unités atomiques disponibles sur {count} UTXO.',
    'module.insufficientFeeBacking':
      'La valeur BCH attachée aux entrées de financement des tokens ne suffit pas à couvrir les frais réseau.',
    'module.insufficientPoolTokenUtxos':
      'Il n’y a pas assez d’UTXO de tokens pour ce pool. {available} unités atomiques disponibles sur {count} UTXO.',
    'module.insufficientPoolBch':
      'Il n’y a pas assez de BCH pour créer ce pool.',
    'module.ownerBchFundingMissing':
      'Aucun UTXO de financement BCH trouvé pour l’adresse du propriétaire du pool ({address}).',
  },
  ko: {
    'module.insufficientBchUtxos': '이 교환에 사용할 BCH UTXO가 부족합니다.',
    'module.insufficientSwapTokenUtxos':
      '이 교환에 사용할 토큰 UTXO가 부족합니다. UTXO {count}개에 원자 단위 {available}이 있습니다.',
    'module.insufficientFeeBacking':
      '토큰 자금 입력에 연결된 BCH가 네트워크 수수료를 충당하기에 부족합니다.',
    'module.insufficientPoolTokenUtxos':
      '이 풀에 사용할 토큰 UTXO가 부족합니다. UTXO {count}개에 원자 단위 {available}이 있습니다.',
    'module.insufficientPoolBch': '이 풀을 만들 BCH가 부족합니다.',
    'module.ownerBchFundingMissing':
      '풀 소유자 주소({address})에 사용할 BCH 자금 UTXO를 찾지 못했습니다.',
  },
  ja: {
    'module.insufficientBchUtxos':
      'この交換に使用できるBCH UTXOが不足しています。',
    'module.insufficientSwapTokenUtxos':
      'この交換に使用できるトークンUTXOが不足しています。{count}個のUTXOに{available}原子単位があります。',
    'module.insufficientFeeBacking':
      'トークン資金入力に付随するBCHがネットワーク手数料をまかなうには不足しています。',
    'module.insufficientPoolTokenUtxos':
      'このプールに使用できるトークンUTXOが不足しています。{count}個のUTXOに{available}原子単位があります。',
    'module.insufficientPoolBch': 'このプールを作成するBCHが不足しています。',
    'module.ownerBchFundingMissing':
      'プール所有者アドレス（{address}）のBCH資金UTXOが見つかりません。',
  },
  ru: {
    'module.insufficientBchUtxos':
      'Недостаточно доступных BCH UTXO для этого обмена.',
    'module.insufficientSwapTokenUtxos':
      'Недостаточно токеновых UTXO для этого обмена. Доступно {available} атомарных единиц в {count} UTXO.',
    'module.insufficientFeeBacking':
      'BCH во входах финансирования токенов недостаточно для покрытия комиссии сети.',
    'module.insufficientPoolTokenUtxos':
      'Недостаточно токеновых UTXO для этого пула. Доступно {available} атомарных единиц в {count} UTXO.',
    'module.insufficientPoolBch': 'Недостаточно BCH для создания этого пула.',
    'module.ownerBchFundingMissing':
      'Не найден BCH UTXO для финансирования адреса владельца пула ({address}).',
  },
  'ha-NG': {
    'module.insufficientBchUtxos':
      'Babu isassun BCH UTXO da ake da su don wannan musayar.',
    'module.insufficientSwapTokenUtxos':
      'Babu isassun token UTXO don wannan musayar. Akwai atomic {available} a cikin UTXO {count}.',
    'module.insufficientFeeBacking':
      'BCH da ke tare da abubuwan shigar token bai isa ya biya kuɗin hanyar sadarwa ba.',
    'module.insufficientPoolTokenUtxos':
      'Babu isassun token UTXO don wannan wurin. Akwai atomic {available} a cikin UTXO {count}.',
    'module.insufficientPoolBch': 'Babu isasshen BCH don ƙirƙirar wannan wuri.',
    'module.ownerBchFundingMissing':
      'Ba a sami BCH UTXO na kuɗin adireshin mai wurin ({address}) ba.',
  },
};

const completeMessages = Object.fromEntries(
  Object.entries(messages).map(([locale, localeMessages]) => [
    locale,
    {
      ...localeMessages,
      ...extraMessages[locale as keyof typeof extraMessages],
      ...statusMessages[locale as keyof typeof statusMessages],
      ...liquidityLabelMessages[locale as keyof typeof liquidityLabelMessages],
      ...auxiliaryMessages[locale as keyof typeof auxiliaryMessages],
      ...safetyMessages[locale as keyof typeof safetyMessages],
      ...preflightMessages[locale as keyof typeof preflightMessages],
      ...fundingMessages[locale as keyof typeof fundingMessages],
    },
  ])
) as AddonModuleLocaleMessages;

export const CAULDRON_LOCALE_BUNDLES = createAddonModuleLocaleBundles(
  completeMessages,
  ADDON_COMMON_MESSAGES
);
