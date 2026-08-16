import {
  createAddonModuleLocaleBundles,
  type AddonModuleLocaleMessages,
} from '../../../i18n/addonModuleLocale';
import type { AddonLocale } from '../../../types/addons';
import { ADDON_COMMON_MESSAGES } from '../locales/common';

export const MEMO_CASH_MODULE_ID = 'memo-cash-reader' as const;

const messages: AddonModuleLocaleMessages = {
  en: {
    'module.title': 'Memo.cash Reader',
    'module.perPage': 'per page',
    'module.noPayload': 'No text payload',
    'module.replies': 'Replies',
    'module.post': 'Post',
    'module.follow': 'Follow',
    'module.unfollow': 'Unfollow',
  },
  es: {
    'module.title': 'Lector de Memo.cash',
    'module.perPage': 'por página',
    'module.noPayload': 'Sin contenido de texto',
    'module.replies': 'Respuestas',
    'module.post': 'Publicar',
    'module.follow': 'Seguir',
    'module.unfollow': 'Dejar de seguir',
  },
  'pt-BR': {
    'module.title': 'Leitor do Memo.cash',
    'module.perPage': 'por página',
    'module.noPayload': 'Sem conteúdo de texto',
    'module.replies': 'Respostas',
    'module.post': 'Publicar',
    'module.follow': 'Seguir',
    'module.unfollow': 'Deixar de seguir',
  },
  'zh-CN': {
    'module.title': 'Memo.cash 阅读器',
    'module.perPage': '每页',
    'module.noPayload': '没有文本内容',
    'module.replies': '回复',
    'module.post': '发布',
    'module.follow': '关注',
    'module.unfollow': '取消关注',
  },
  'zh-TW': {
    'module.title': 'Memo.cash 閱讀器',
    'module.perPage': '每頁',
    'module.noPayload': '沒有文字內容',
    'module.replies': '回覆',
    'module.post': '發佈',
    'module.follow': '追蹤',
    'module.unfollow': '取消追蹤',
  },
  vi: {
    'module.title': 'Trình đọc Memo.cash',
    'module.perPage': 'mỗi trang',
    'module.noPayload': 'Không có nội dung văn bản',
    'module.replies': 'Phản hồi',
    'module.post': 'Đăng',
    'module.follow': 'Theo dõi',
    'module.unfollow': 'Bỏ theo dõi',
  },
  ar: {
    'module.title': 'قارئ Memo.cash',
    'module.perPage': 'لكل صفحة',
    'module.noPayload': 'لا يوجد محتوى نصي',
    'module.replies': 'الردود',
    'module.post': 'نشر',
    'module.follow': 'متابعة',
    'module.unfollow': 'إلغاء المتابعة',
  },
  fr: {
    'module.title': 'Lecteur Memo.cash',
    'module.perPage': 'par page',
    'module.noPayload': 'Aucun contenu textuel',
    'module.replies': 'Réponses',
    'module.post': 'Publier',
    'module.follow': 'Suivre',
    'module.unfollow': 'Ne plus suivre',
  },
  ko: {
    'module.title': 'Memo.cash 리더',
    'module.perPage': '페이지당',
    'module.noPayload': '텍스트 내용 없음',
    'module.replies': '답글',
    'module.post': '게시',
    'module.follow': '팔로우',
    'module.unfollow': '팔로우 취소',
  },
  ja: {
    'module.title': 'Memo.cash リーダー',
    'module.perPage': 'ページあたり',
    'module.noPayload': 'テキストの内容はありません',
    'module.replies': '返信',
    'module.post': '投稿',
    'module.follow': 'フォロー',
    'module.unfollow': 'フォロー解除',
  },
  ru: {
    'module.title': 'Читатель Memo.cash',
    'module.perPage': 'на страницу',
    'module.noPayload': 'Текстовых данных нет',
    'module.replies': 'Ответы',
    'module.post': 'Опубликовать',
    'module.follow': 'Подписаться',
    'module.unfollow': 'Отписаться',
  },
  'ha-NG': {
    'module.title': 'Mai karanta Memo.cash',
    'module.perPage': 'a kowane shafi',
    'module.noPayload': 'Babu bayanin rubutu',
    'module.replies': 'Amsoshi',
    'module.post': 'Buga',
    'module.follow': 'Bi',
    'module.unfollow': 'Daina bi',
  },
};

const supplementalMessages: AddonModuleLocaleMessages = {
  en: {
    'module.description': 'Cursor-paginated OP_RETURN feed from Chaingraph.',
  },
  es: {
    'module.description':
      'Feed OP_RETURN paginado por cursor desde Chaingraph.',
  },
  'pt-BR': {
    'module.description': 'Feed OP_RETURN paginado por cursor do Chaingraph.',
  },
  'zh-CN': {
    'module.description': '来自 Chaingraph、按游标分页的 OP_RETURN 信息流。',
  },
  'zh-TW': {
    'module.description': '來自 Chaingraph、按游標分頁的 OP_RETURN 資訊流。',
  },
  vi: {
    'module.description':
      'Nguồn cấp OP_RETURN phân trang bằng cursor từ Chaingraph.',
  },
  ar: {
    'module.description': 'تدفق OP_RETURN مقسّم بالموضع من Chaingraph.',
  },
  fr: {
    'module.description':
      'Flux OP_RETURN paginé par curseur depuis Chaingraph.',
  },
  ko: {
    'module.description':
      'Chaingraph에서 커서로 페이지를 나눈 OP_RETURN 피드입니다.',
  },
  ja: {
    'module.description':
      'Chaingraphから取得するカーソルページ形式のOP_RETURNフィード。',
  },
  ru: {
    'module.description':
      'Лента OP_RETURN с постраничной навигацией по курсору из Chaingraph.',
  },
  'ha-NG': {
    'module.description':
      'Rafin OP_RETURN mai Chaingraph da aka raba ta cursor.',
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

export const MEMO_CASH_LOCALE_BUNDLES = createAddonModuleLocaleBundles(
  completeMessages,
  ADDON_COMMON_MESSAGES
);
