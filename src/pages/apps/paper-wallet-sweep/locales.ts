import {
  createAddonModuleLocaleBundles,
  type AddonModuleLocaleMessages,
} from '../../../i18n/addonModuleLocale';
import type { AddonLocale } from '../../../types/addons';
import { ADDON_COMMON_MESSAGES } from '../locales/common';

export const PAPER_WALLET_MODULE_ID = 'paper-wallet' as const;

const messages: AddonModuleLocaleMessages = {
  en: {
    'module.title': 'Paper wallet',
    'module.scan': 'Scan QR',
    'module.sweep': 'Sweep',
    'module.notScanned': 'Not scanned',
    'module.utxosTitle': 'Spendable outputs',
    'module.tokenGroups': 'Token groups',
    'module.noCashTokens': 'No CashTokens found.',
    'module.oneTransaction': 'One transaction',
    'module.tokenBacking': 'Token backing is preserved.',
    'module.confirmSweep': 'Confirm sweep',
    'module.sweepSubtitle':
      'Slide to confirm the one-transaction paper wallet sweep.',
    'module.paperWalletInputs': 'Paper wallet inputs',
    'module.walletFeeInputs': 'Wallet fee inputs',
    'module.tokenOutputs': 'Token outputs',
    'module.bchOutputs': 'BCH outputs',
    'module.noQr': 'No QR code detected. Please try again.',
  },
  es: {
    'module.title': 'Cartera de papel',
    'module.scan': 'Escanear QR',
    'module.sweep': 'Barrer',
    'module.notScanned': 'Sin escanear',
    'module.utxosTitle': 'Salidas disponibles',
    'module.tokenGroups': 'Grupos de tokens',
    'module.noCashTokens': 'No se encontraron CashTokens.',
    'module.oneTransaction': 'Una transacción',
    'module.tokenBacking': 'Se conserva el respaldo de tokens.',
    'module.confirmSweep': 'Confirmar barrido',
    'module.sweepSubtitle':
      'Desliza para confirmar el barrido de la cartera de papel en una transacción.',
    'module.paperWalletInputs': 'Entradas de la cartera de papel',
    'module.walletFeeInputs': 'Entradas de comisión de la cartera',
    'module.tokenOutputs': 'Salidas de tokens',
    'module.bchOutputs': 'Salidas de BCH',
    'module.noQr': 'No se detectó ningún código QR. Inténtalo de nuevo.',
  },
  'pt-BR': {
    'module.title': 'Carteira de papel',
    'module.scan': 'Escanear QR',
    'module.sweep': 'Varredura',
    'module.notScanned': 'Não escaneado',
    'module.utxosTitle': 'Saídas disponíveis',
    'module.tokenGroups': 'Grupos de tokens',
    'module.noCashTokens': 'Nenhum CashToken encontrado.',
    'module.oneTransaction': 'Uma transação',
    'module.tokenBacking': 'O lastro dos tokens é preservado.',
    'module.confirmSweep': 'Confirmar varredura',
    'module.sweepSubtitle':
      'Deslize para confirmar a varredura da carteira de papel em uma transação.',
    'module.paperWalletInputs': 'Entradas da carteira de papel',
    'module.walletFeeInputs': 'Entradas de taxa da carteira',
    'module.tokenOutputs': 'Saídas de tokens',
    'module.bchOutputs': 'Saídas de BCH',
    'module.noQr': 'Nenhum código QR detectado. Tente novamente.',
  },
  'zh-CN': {
    'module.title': '纸钱包',
    'module.scan': '扫描 QR',
    'module.sweep': '归集',
    'module.notScanned': '尚未扫描',
    'module.utxosTitle': '可使用的输出',
    'module.tokenGroups': '代币组',
    'module.noCashTokens': '未找到 CashTokens。',
    'module.oneTransaction': '一笔交易',
    'module.tokenBacking': '代币支持将被保留。',
    'module.confirmSweep': '确认归集',
    'module.sweepSubtitle': '滑动以确认通过一笔交易归集纸钱包。',
    'module.paperWalletInputs': '纸钱包输入',
    'module.walletFeeInputs': '钱包费用输入',
    'module.tokenOutputs': '代币输出',
    'module.bchOutputs': 'BCH 输出',
    'module.noQr': '未检测到二维码。请重试。',
  },
  'zh-TW': {
    'module.title': '紙錢包',
    'module.scan': '掃描 QR',
    'module.sweep': '歸集',
    'module.notScanned': '尚未掃描',
    'module.utxosTitle': '可使用的輸出',
    'module.tokenGroups': '代幣群組',
    'module.noCashTokens': '找不到 CashTokens。',
    'module.oneTransaction': '一筆交易',
    'module.tokenBacking': '代幣支援會被保留。',
    'module.confirmSweep': '確認歸集',
    'module.sweepSubtitle': '滑動以確認透過一筆交易歸集紙錢包。',
    'module.paperWalletInputs': '紙錢包輸入',
    'module.walletFeeInputs': '錢包費用輸入',
    'module.tokenOutputs': '代幣輸出',
    'module.bchOutputs': 'BCH 輸出',
    'module.noQr': '未偵測到 QR 碼。請重試。',
  },
  vi: {
    'module.title': 'Ví giấy',
    'module.scan': 'Quét QR',
    'module.sweep': 'Quét',
    'module.notScanned': 'Chưa quét',
    'module.utxosTitle': 'Đầu ra có thể dùng',
    'module.tokenGroups': 'Nhóm token',
    'module.noCashTokens': 'Không tìm thấy CashTokens.',
    'module.oneTransaction': 'Một giao dịch',
    'module.tokenBacking': 'Phần bảo chứng token được giữ nguyên.',
    'module.confirmSweep': 'Xác nhận quét',
    'module.sweepSubtitle':
      'Vuốt để xác nhận quét ví giấy trong một giao dịch.',
    'module.paperWalletInputs': 'Đầu vào ví giấy',
    'module.walletFeeInputs': 'Đầu vào phí ví',
    'module.tokenOutputs': 'Đầu ra token',
    'module.bchOutputs': 'Đầu ra BCH',
    'module.noQr': 'Không phát hiện mã QR. Vui lòng thử lại.',
  },
  ar: {
    'module.title': 'محفظة ورقية',
    'module.scan': 'مسح QR',
    'module.sweep': 'تجميع',
    'module.notScanned': 'لم يتم المسح',
    'module.utxosTitle': 'المخرجات القابلة للاستخدام',
    'module.tokenGroups': 'مجموعات الرموز',
    'module.noCashTokens': 'لم يتم العثور على CashTokens.',
    'module.oneTransaction': 'معاملة واحدة',
    'module.tokenBacking': 'يتم الحفاظ على دعم الرموز.',
    'module.confirmSweep': 'تأكيد التجميع',
    'module.sweepSubtitle':
      'اسحب لتأكيد تجميع المحفظة الورقية في معاملة واحدة.',
    'module.paperWalletInputs': 'مدخلات المحفظة الورقية',
    'module.walletFeeInputs': 'مدخلات رسوم المحفظة',
    'module.tokenOutputs': 'مخرجات الرموز',
    'module.bchOutputs': 'مخرجات BCH',
    'module.noQr': 'لم يتم اكتشاف رمز QR. يرجى المحاولة مجددًا.',
  },
  fr: {
    'module.title': 'Portefeuille papier',
    'module.scan': 'Scanner le QR',
    'module.sweep': 'Balayer',
    'module.notScanned': 'Non scanné',
    'module.utxosTitle': 'Sorties disponibles',
    'module.tokenGroups': 'Groupes de tokens',
    'module.noCashTokens': 'Aucun CashToken trouvé.',
    'module.oneTransaction': 'Une transaction',
    'module.tokenBacking': 'Le support des tokens est préservé.',
    'module.confirmSweep': 'Confirmer le balayage',
    'module.sweepSubtitle':
      'Faites glisser pour confirmer le balayage du portefeuille papier en une transaction.',
    'module.paperWalletInputs': 'Entrées du portefeuille papier',
    'module.walletFeeInputs': 'Entrées de frais du portefeuille',
    'module.tokenOutputs': 'Sorties de tokens',
    'module.bchOutputs': 'Sorties BCH',
    'module.noQr': 'Aucun code QR détecté. Veuillez réessayer.',
  },
  ko: {
    'module.title': '종이 지갑',
    'module.scan': 'QR 스캔',
    'module.sweep': '스윕',
    'module.notScanned': '스캔하지 않음',
    'module.utxosTitle': '사용 가능한 출력',
    'module.tokenGroups': '토큰 그룹',
    'module.noCashTokens': 'CashTokens를 찾지 못했습니다.',
    'module.oneTransaction': '한 번의 거래',
    'module.tokenBacking': '토큰 담보가 유지됩니다.',
    'module.confirmSweep': '스윕 확인',
    'module.sweepSubtitle':
      '한 번의 거래로 종이 지갑을 스윕하려면 밀어서 확인합니다.',
    'module.paperWalletInputs': '종이 지갑 입력',
    'module.walletFeeInputs': '지갑 수수료 입력',
    'module.tokenOutputs': '토큰 출력',
    'module.bchOutputs': 'BCH 출력',
    'module.noQr': 'QR 코드를 찾지 못했습니다. 다시 시도하세요.',
  },
  ja: {
    'module.title': 'ペーパーウォレット',
    'module.scan': 'QRをスキャン',
    'module.sweep': 'スイープ',
    'module.notScanned': '未スキャン',
    'module.utxosTitle': '使用可能な出力',
    'module.tokenGroups': 'トークングループ',
    'module.noCashTokens': 'CashTokensが見つかりません。',
    'module.oneTransaction': '1回のトランザクション',
    'module.tokenBacking': 'トークンの裏付けは維持されます。',
    'module.confirmSweep': 'スイープを確認',
    'module.sweepSubtitle':
      '1回のトランザクションでペーパーウォレットをスイープするにはスライドして確認します。',
    'module.paperWalletInputs': 'ペーパーウォレットの入力',
    'module.walletFeeInputs': 'ウォレット手数料の入力',
    'module.tokenOutputs': 'トークン出力',
    'module.bchOutputs': 'BCH出力',
    'module.noQr': 'QRコードを検出できませんでした。もう一度お試しください。',
  },
  ru: {
    'module.title': 'Бумажный кошелёк',
    'module.scan': 'Сканировать QR',
    'module.sweep': 'Собрать',
    'module.notScanned': 'Не отсканировано',
    'module.utxosTitle': 'Доступные выходы',
    'module.tokenGroups': 'Группы токенов',
    'module.noCashTokens': 'CashTokens не найдены.',
    'module.oneTransaction': 'Одна транзакция',
    'module.tokenBacking': 'Обеспечение токенов сохраняется.',
    'module.confirmSweep': 'Подтвердить сбор',
    'module.sweepSubtitle':
      'Сдвиньте, чтобы подтвердить сбор бумажного кошелька одной транзакцией.',
    'module.paperWalletInputs': 'Входы бумажного кошелька',
    'module.walletFeeInputs': 'Входы комиссии кошелька',
    'module.tokenOutputs': 'Выходы токенов',
    'module.bchOutputs': 'Выходы BCH',
    'module.noQr': 'QR-код не обнаружен. Повторите попытку.',
  },
  'ha-NG': {
    'module.title': 'Walat na takarda',
    'module.scan': 'Duba QR',
    'module.sweep': 'Tattara',
    'module.notScanned': 'Ba a duba ba',
    'module.utxosTitle': 'Abubuwan fita da za a iya amfani da su',
    'module.tokenGroups': 'Rukunin token',
    'module.noCashTokens': 'Ba a sami CashTokens ba.',
    'module.oneTransaction': 'Ciniki ɗaya',
    'module.tokenBacking': 'Za a kiyaye tallafin token.',
    'module.confirmSweep': 'Tabbatar da tattarawa',
    'module.sweepSubtitle':
      'Ja don tabbatar da tattara walat na takarda a ciniki ɗaya.',
    'module.paperWalletInputs': 'Abubuwan shiga na walat na takarda',
    'module.walletFeeInputs': 'Abubuwan shiga kuɗin walat',
    'module.tokenOutputs': 'Abubuwan fita na token',
    'module.bchOutputs': 'Abubuwan fita na BCH',
    'module.noQr': 'Ba a gano lambar QR ba. Sake gwadawa.',
  },
};

const supplementalMessages: AddonModuleLocaleMessages = {
  en: {
    'module.description':
      'Scan a WIF paper wallet and sweep BCH + CashTokens in one transaction.',
  },
  es: {
    'module.description':
      'Escanea una cartera de papel WIF y retira BCH + CashTokens en una sola transacción.',
  },
  'pt-BR': {
    'module.description':
      'Escaneie uma carteira de papel WIF e transfira BCH + CashTokens em uma única transação.',
  },
  'zh-CN': {
    'module.description':
      '扫描 WIF 纸钱包，并在一笔交易中转移 BCH 和 CashTokens。',
  },
  'zh-TW': {
    'module.description':
      '掃描 WIF 紙錢包，並在一筆交易中轉移 BCH 與 CashTokens。',
  },
  vi: {
    'module.description':
      'Quét ví giấy WIF và chuyển BCH + CashTokens trong một giao dịch.',
  },
  ar: {
    'module.description':
      'امسح محفظة WIF الورقية وانقل BCH وCashTokens في معاملة واحدة.',
  },
  fr: {
    'module.description':
      'Scannez un portefeuille papier WIF et transférez BCH et CashTokens en une seule transaction.',
  },
  ko: {
    'module.description':
      'WIF 종이 지갑을 스캔하고 한 번의 트랜잭션으로 BCH와 CashTokens를 스윕합니다.',
  },
  ja: {
    'module.description':
      'WIFペーパーウォレットをスキャンし、1回のトランザクションでBCHとCashTokensを移します。',
  },
  ru: {
    'module.description':
      'Сканируйте бумажный кошелёк WIF и переведите BCH и CashTokens одной транзакцией.',
  },
  'ha-NG': {
    'module.description':
      'Duba walat na takarda WIF kuma tattara BCH da CashTokens a ciniki ɗaya.',
  },
};

const completeMessages = Object.fromEntries(
  Object.entries(messages).map(([locale, localeMessages]) => [
    locale,
    {
      ...localeMessages,
      ...supplementalMessages[locale as AddonLocale],
    },
  ])
) as AddonModuleLocaleMessages;

export const PAPER_WALLET_LOCALE_BUNDLES = createAddonModuleLocaleBundles(
  completeMessages,
  ADDON_COMMON_MESSAGES
);
