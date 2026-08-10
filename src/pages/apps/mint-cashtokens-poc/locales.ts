import {
  createAddonModuleLocaleBundles,
  type AddonModuleLocaleMessages,
} from '../../../i18n/addonModuleLocale';
import type { AddonLocale } from '../../../types/addons';
import { ADDON_COMMON_MESSAGES } from '../locales/common';

export const MINT_CASH_TOKENS_MODULE_ID = 'mint-cashtokens' as const;

const messages: AddonModuleLocaleMessages = {
  en: {
    'module.sourceUtxos': 'Source UTXOs',
    'module.recipients': 'Recipients',
    'module.amounts': 'Amounts',
    'module.tokenCategory': 'Token category',
    'module.name': 'Name',
    'module.symbol': 'Symbol',
    'module.description': 'Description',
    'module.decimals': 'Decimals',
    'module.iconUri': 'Icon URI',
    'module.officialSite': 'Official site',
    'module.broadcastWarning':
      'This will broadcast immediately after confirmation.',
  },
  es: {
    'module.sourceUtxos': 'UTXO de origen',
    'module.recipients': 'Destinatarios',
    'module.amounts': 'Cantidades',
    'module.tokenCategory': 'Categoría del token',
    'module.name': 'Nombre',
    'module.symbol': 'Símbolo',
    'module.description': 'Descripción',
    'module.decimals': 'Decimales',
    'module.iconUri': 'URI del icono',
    'module.officialSite': 'Sitio oficial',
    'module.broadcastWarning':
      'Esto se transmitirá inmediatamente después de la confirmación.',
  },
  'pt-BR': {
    'module.sourceUtxos': 'UTXOs de origem',
    'module.recipients': 'Destinatários',
    'module.amounts': 'Valores',
    'module.tokenCategory': 'Categoria do token',
    'module.name': 'Nome',
    'module.symbol': 'Símbolo',
    'module.description': 'Descrição',
    'module.decimals': 'Casas decimais',
    'module.iconUri': 'URI do ícone',
    'module.officialSite': 'Site oficial',
    'module.broadcastWarning':
      'Isso será transmitido imediatamente após a confirmação.',
  },
  'zh-CN': {
    'module.sourceUtxos': '来源 UTXO',
    'module.recipients': '收款人',
    'module.amounts': '数量',
    'module.tokenCategory': '代币类别',
    'module.name': '名称',
    'module.symbol': '符号',
    'module.description': '描述',
    'module.decimals': '小数位',
    'module.iconUri': '图标 URI',
    'module.officialSite': '官方网站',
    'module.broadcastWarning': '确认后将立即广播。',
  },
  'zh-TW': {
    'module.sourceUtxos': '來源 UTXO',
    'module.recipients': '收款人',
    'module.amounts': '數量',
    'module.tokenCategory': '代幣類別',
    'module.name': '名稱',
    'module.symbol': '符號',
    'module.description': '描述',
    'module.decimals': '小數位數',
    'module.iconUri': '圖示 URI',
    'module.officialSite': '官方網站',
    'module.broadcastWarning': '確認後將立即廣播。',
  },
  vi: {
    'module.sourceUtxos': 'UTXO nguồn',
    'module.recipients': 'Người nhận',
    'module.amounts': 'Số lượng',
    'module.tokenCategory': 'Danh mục token',
    'module.name': 'Tên',
    'module.symbol': 'Ký hiệu',
    'module.description': 'Mô tả',
    'module.decimals': 'Số chữ số thập phân',
    'module.iconUri': 'URI biểu tượng',
    'module.officialSite': 'Trang chính thức',
    'module.broadcastWarning': 'Giao dịch sẽ được phát ngay sau khi xác nhận.',
  },
  ar: {
    'module.sourceUtxos': 'UTXO المصدر',
    'module.recipients': 'المستلمون',
    'module.amounts': 'المبالغ',
    'module.tokenCategory': 'فئة الرمز',
    'module.name': 'الاسم',
    'module.symbol': 'الرمز',
    'module.description': 'الوصف',
    'module.decimals': 'المنازل العشرية',
    'module.iconUri': 'URI للأيقونة',
    'module.officialSite': 'الموقع الرسمي',
    'module.broadcastWarning': 'سيتم بث هذا فور التأكيد.',
  },
  fr: {
    'module.sourceUtxos': 'UTXO sources',
    'module.recipients': 'Destinataires',
    'module.amounts': 'Montants',
    'module.tokenCategory': 'Catégorie du token',
    'module.name': 'Nom',
    'module.symbol': 'Symbole',
    'module.description': 'Description',
    'module.decimals': 'Décimales',
    'module.iconUri': 'URI de l’icône',
    'module.officialSite': 'Site officiel',
    'module.broadcastWarning':
      'La transaction sera diffusée immédiatement après confirmation.',
  },
  ko: {
    'module.sourceUtxos': '소스 UTXO',
    'module.recipients': '수신자',
    'module.amounts': '수량',
    'module.tokenCategory': '토큰 카테고리',
    'module.name': '이름',
    'module.symbol': '기호',
    'module.description': '설명',
    'module.decimals': '소수 자릿수',
    'module.iconUri': '아이콘 URI',
    'module.officialSite': '공식 사이트',
    'module.broadcastWarning': '확인 후 즉시 브로드캐스트됩니다.',
  },
  ja: {
    'module.sourceUtxos': 'ソースUTXO',
    'module.recipients': '受取人',
    'module.amounts': '数量',
    'module.tokenCategory': 'トークンカテゴリ',
    'module.name': '名前',
    'module.symbol': 'シンボル',
    'module.description': '説明',
    'module.decimals': '小数桁',
    'module.iconUri': 'アイコンURI',
    'module.officialSite': '公式サイト',
    'module.broadcastWarning': '確認後すぐにブロードキャストされます。',
  },
  ru: {
    'module.sourceUtxos': 'Исходные UTXO',
    'module.recipients': 'Получатели',
    'module.amounts': 'Суммы',
    'module.tokenCategory': 'Категория токена',
    'module.name': 'Название',
    'module.symbol': 'Символ',
    'module.description': 'Описание',
    'module.decimals': 'Десятичные знаки',
    'module.iconUri': 'URI значка',
    'module.officialSite': 'Официальный сайт',
    'module.broadcastWarning':
      'После подтверждения транзакция будет немедленно отправлена в сеть.',
  },
  'ha-NG': {
    'module.sourceUtxos': 'UTXO na tushe',
    'module.recipients': 'Masu karɓa',
    'module.amounts': 'Adadi',
    'module.tokenCategory': 'Rukunin token',
    'module.name': 'Suna',
    'module.symbol': 'Alama',
    'module.description': 'Bayani',
    'module.decimals': 'Goma-goma',
    'module.iconUri': 'URI na alama',
    'module.officialSite': 'Shafin hukuma',
    'module.broadcastWarning': 'Za a aika wannan nan da nan bayan tabbatarwa.',
  },
};

const supplementalMessages: AddonModuleLocaleMessages = {
  en: {
    'module.sourceHelp':
      'Pick a genesis UTXO to create a category, or a minting NFT authority to mint additional CashTokens.',
    'module.bcmrPresent': 'BCMR already present',
    'module.selectMintSource': 'Select one mint source to derive category',
    'module.optionalHex': 'optional hex',
  },
  es: {
    'module.sourceHelp':
      'Elige un UTXO génesis para crear una categoría o una autoridad NFT de emisión para crear más CashTokens.',
    'module.bcmrPresent': 'BCMR ya está presente',
    'module.selectMintSource':
      'Selecciona una fuente de emisión para derivar la categoría',
    'module.optionalHex': 'hex opcional',
  },
  'pt-BR': {
    'module.sourceHelp':
      'Escolha um UTXO gênesis para criar uma categoria ou uma autoridade NFT de emissão para criar mais CashTokens.',
    'module.bcmrPresent': 'BCMR já presente',
    'module.selectMintSource':
      'Selecione uma fonte de emissão para derivar a categoria',
    'module.optionalHex': 'hex opcional',
  },
  'zh-CN': {
    'module.sourceHelp':
      '选择创世 UTXO 创建类别，或选择铸造 NFT 权限以铸造更多 CashTokens。',
    'module.bcmrPresent': '已有 BCMR',
    'module.selectMintSource': '选择一个铸造来源以推导类别',
    'module.optionalHex': '可选十六进制',
  },
  'zh-TW': {
    'module.sourceHelp':
      '選擇創世 UTXO 以建立類別，或選擇鑄造 NFT 權限以鑄造更多 CashTokens。',
    'module.bcmrPresent': '已有 BCMR',
    'module.selectMintSource': '選擇一個鑄造來源以推導類別',
    'module.optionalHex': '選用十六進位',
  },
  vi: {
    'module.sourceHelp':
      'Chọn UTXO genesis để tạo danh mục hoặc quyền NFT đúc để đúc thêm CashTokens.',
    'module.bcmrPresent': 'Đã có BCMR',
    'module.selectMintSource': 'Chọn một nguồn đúc để suy ra danh mục',
    'module.optionalHex': 'hex tùy chọn',
  },
  ar: {
    'module.sourceHelp':
      'اختر UTXO تأسيسيًا لإنشاء فئة، أو سلطة NFT للسك لسك CashTokens إضافية.',
    'module.bcmrPresent': 'BCMR موجود بالفعل',
    'module.selectMintSource': 'اختر مصدر سك واحدًا لاشتقاق الفئة',
    'module.optionalHex': 'سداسي عشري اختياري',
  },
  fr: {
    'module.sourceHelp':
      'Choisissez un UTXO genesis pour créer une catégorie, ou une autorité NFT de frappe pour créer d’autres CashTokens.',
    'module.bcmrPresent': 'BCMR déjà présent',
    'module.selectMintSource':
      'Sélectionnez une source de frappe pour déduire la catégorie',
    'module.optionalHex': 'hexadécimal facultatif',
  },
  ko: {
    'module.sourceHelp':
      '카테고리를 만들 제네시스 UTXO 또는 추가 CashTokens를 발행할 민팅 NFT 권한을 선택하세요.',
    'module.bcmrPresent': 'BCMR이 이미 있습니다',
    'module.selectMintSource': '카테고리를 계산할 민팅 소스를 하나 선택하세요',
    'module.optionalHex': '선택적 16진수',
  },
  ja: {
    'module.sourceHelp':
      'カテゴリを作成するジェネシスUTXO、または追加のCashTokensを発行するミントNFT権限を選択します。',
    'module.bcmrPresent': 'BCMRはすでに存在します',
    'module.selectMintSource': 'カテゴリを導出するミントソースを1つ選択',
    'module.optionalHex': '任意の16進数',
  },
  ru: {
    'module.sourceHelp':
      'Выберите исходный UTXO для создания категории или NFT-полномочие выпуска для выпуска дополнительных CashTokens.',
    'module.bcmrPresent': 'BCMR уже есть',
    'module.selectMintSource':
      'Выберите источник выпуска для определения категории',
    'module.optionalHex': 'необязательный hex',
  },
  'ha-NG': {
    'module.sourceHelp':
      'Zaɓi UTXO na genesis don ƙirƙirar rukuni, ko ikon NFT na mint don ƙirƙirar ƙarin CashTokens.',
    'module.bcmrPresent': 'BCMR yana nan',
    'module.selectMintSource': 'Zaɓi tushen mint guda don samo rukuni',
    'module.optionalHex': 'hex na zaɓi',
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

export const MINT_CASH_TOKENS_LOCALE_BUNDLES = createAddonModuleLocaleBundles(
  completeMessages,
  ADDON_COMMON_MESSAGES
);
