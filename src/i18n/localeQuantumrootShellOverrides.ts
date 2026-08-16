import type { BaseLocale, SupportedLocale } from './types';

type AddedLocale = Exclude<SupportedLocale, BaseLocale>;

/** Entry screen and vault-status copy for the Quantumroot workspace. */
export const localeQuantumrootShellOverrides: Partial<
  Record<AddedLocale, Record<string, string>>
> = {
  'pt-BR': {
    'quantumroot.subtitle': 'Duas linhas de gasto em um único cofre',
    'quantumroot.betaProduction': 'Produção beta',
    'quantumroot.betaTitle': 'Produção beta do Quantumroot',
    'quantumroot.livePreview': 'Prévia ao vivo',
    'quantumroot.mainnetPreview':
      'A prévia da Mainnet permanece visível antes da ativação.',
    'quantumroot.activeWorkspace':
      'Área de trabalho ativa para o fluxo Quantumroot de produção beta.',
    'quantumroot.mainnetAhead':
      'O Quantumroot está visível na Mainnet antes da ativação. O layout continua disponível, mas as ações principais ficam desativadas até {date}.',
    'quantumroot.activeNetwork':
      'O Quantumroot está ativo nesta rede. Use a área de trabalho abaixo para gerenciar uma linha de gasto normal e uma linha de recuperação resistente a quantum.',
    'quantumroot.trackedBalance': 'Saldo monitorado',
    'quantumroot.vaults': 'Cofres',
    'quantumroot.funded': '{count} financiados',
    'quantumroot.syncingVaults': 'Sincronizando cofres…',
    'quantumroot.syncVaults': 'Sincronizar cofres',
    'quantumroot.openVaults': 'Abrir cofres',
    'quantumroot.liveNow':
      'Disponível agora: gasto normal, monitoramento de saldo e recuperação de BCH pelo Quantum Lock.',
    'quantumroot.guidedNow':
      'Orientado agora: escolha uma chave de aprovação, bloqueie-a no Quantum Lock e gaste a moeda correspondente.',
    'quantumroot.back': 'Voltar',
    'quantumroot.close': 'Fechar',
    'quantumroot.workspaceRefreshFailed':
      'Falha ao atualizar a área de trabalho',
    'quantumroot.noVaults':
      'Nenhum cofre Quantumroot foi derivado ainda. Sincronize os cofres para provisioná-los para os índices de endereço existentes da carteira.',
    'quantumroot.refreshing':
      'Atualizando saldos e o status dos UTXOs. Os cofres permanecem disponíveis enquanto a sincronização termina.',
    'quantumroot.vaultNumber': 'Cofre #{id}',
    'quantumroot.checkingBalances': 'Verificando saldos…',
    'quantumroot.readyToRecover': '{count} prontos para recuperar',
    'quantumroot.fundedStatus': 'Financiado',
    'quantumroot.noFundsYet': 'Ainda sem fundos',
  },
  vi: {
    'quantumroot.subtitle': 'Hai tuyến chi tiêu trong một vault',
    'quantumroot.betaProduction': 'Sản xuất beta',
    'quantumroot.betaTitle': 'Quantumroot sản xuất beta',
    'quantumroot.livePreview': 'Bản xem trước trực tiếp',
    'quantumroot.mainnetPreview':
      'Bản xem trước Mainnet vẫn hiển thị trước khi kích hoạt.',
    'quantumroot.activeWorkspace':
      'Không gian hoạt động cho quy trình Quantumroot sản xuất beta.',
    'quantumroot.mainnetAhead':
      'Quantumroot hiển thị trên Mainnet trước khi kích hoạt. Bố cục vẫn dùng được nhưng các thao tác chính bị tắt cho đến {date}.',
    'quantumroot.activeNetwork':
      'Quantumroot đang hoạt động trên mạng này. Dùng không gian bên dưới để quản lý tuyến chi tiêu thường và tuyến khôi phục chống lượng tử.',
    'quantumroot.trackedBalance': 'Số dư được theo dõi',
    'quantumroot.vaults': 'Vault',
    'quantumroot.funded': '{count} đã cấp tiền',
    'quantumroot.syncingVaults': 'Đang đồng bộ vault…',
    'quantumroot.syncVaults': 'Đồng bộ vault',
    'quantumroot.openVaults': 'Mở vault',
    'quantumroot.liveNow':
      'Đã dùng được: chi tiêu thường, theo dõi số dư và khôi phục BCH bằng Quantum Lock.',
    'quantumroot.guidedNow':
      'Có hướng dẫn: chọn một khóa phê duyệt, khóa trong Quantum Lock rồi chi coin tương ứng.',
    'quantumroot.back': 'Quay lại',
    'quantumroot.close': 'Đóng',
    'quantumroot.workspaceRefreshFailed': 'Làm mới không gian thất bại',
    'quantumroot.noVaults':
      'Chưa có vault Quantumroot nào được dẫn xuất. Đồng bộ vault để cấp chúng cho các chỉ mục địa chỉ hiện có của ví.',
    'quantumroot.refreshing':
      'Đang làm mới số dư và trạng thái UTXO. Vault vẫn dùng được trong khi đồng bộ hoàn tất.',
    'quantumroot.vaultNumber': 'Vault #{id}',
    'quantumroot.checkingBalances': 'Đang kiểm tra số dư…',
    'quantumroot.readyToRecover': '{count} sẵn sàng khôi phục',
    'quantumroot.fundedStatus': 'Đã cấp tiền',
    'quantumroot.noFundsYet': 'Chưa có tiền',
  },
  'zh-TW': {
    'quantumroot.subtitle': '一個保管庫中的兩條花費路徑',
    'quantumroot.betaProduction': 'Beta production',
    'quantumroot.betaTitle': 'Quantumroot Beta Production',
    'quantumroot.livePreview': '即時預覽',
    'quantumroot.mainnetPreview': '啟用前會持續顯示 Mainnet 預覽。',
    'quantumroot.activeWorkspace':
      'Beta production Quantumroot 流程的作用中工作區。',
    'quantumroot.mainnetAhead':
      'Quantumroot 在啟用前提前顯示於 Mainnet。版面仍可使用，但主要操作會停用至 {date}。',
    'quantumroot.activeNetwork':
      'Quantumroot 已在此網路啟用。使用下方工作區管理一般花費路徑與抗量子的復原路徑。',
    'quantumroot.trackedBalance': '追蹤中的餘額',
    'quantumroot.vaults': '保管庫',
    'quantumroot.funded': '{count} 個已入金',
    'quantumroot.syncingVaults': '正在同步保管庫…',
    'quantumroot.syncVaults': '同步保管庫',
    'quantumroot.openVaults': '開啟保管庫',
    'quantumroot.liveNow':
      '目前可用：一般花費、餘額追蹤，以及 Quantum Lock BCH 復原。',
    'quantumroot.guidedNow':
      '目前有操作導引：選擇一把核准金鑰，將其鎖定在 Quantum Lock，然後花費對應硬幣。',
    'quantumroot.back': '返回',
    'quantumroot.close': '關閉',
    'quantumroot.workspaceRefreshFailed': '工作區重新整理失敗',
    'quantumroot.noVaults':
      '尚未衍生 Quantumroot 保管庫。請同步保管庫，為現有錢包地址索引建立保管庫。',
    'quantumroot.refreshing':
      '正在重新整理餘額與 UTXO 狀態。同步完成前仍可使用保管庫。',
    'quantumroot.vaultNumber': '保管庫 #{id}',
    'quantumroot.checkingBalances': '正在檢查餘額…',
    'quantumroot.readyToRecover': '{count} 個可復原',
    'quantumroot.fundedStatus': '已入金',
    'quantumroot.noFundsYet': '尚無資金',
  },
  fr: {
    'quantumroot.subtitle': 'Deux voies de dépense dans un même coffre',
    'quantumroot.betaProduction': 'Production bêta',
    'quantumroot.betaTitle': 'Quantumroot en production bêta',
    'quantumroot.livePreview': 'Aperçu en direct',
    'quantumroot.mainnetPreview':
      'L’aperçu Mainnet reste visible avant l’activation.',
    'quantumroot.activeWorkspace':
      'Espace de travail actif pour le parcours Quantumroot en production bêta.',
    'quantumroot.mainnetAhead':
      'Quantumroot est visible sur Mainnet avant son activation. La mise en page reste disponible, mais les actions principales sont désactivées jusqu’au {date}.',
    'quantumroot.activeNetwork':
      'Quantumroot est actif sur ce réseau. Utilisez l’espace ci-dessous pour gérer une voie de dépense normale et une voie de récupération résistante au quantique.',
    'quantumroot.trackedBalance': 'Solde suivi',
    'quantumroot.vaults': 'Coffres',
    'quantumroot.funded': '{count} financé(s)',
    'quantumroot.syncingVaults': 'Synchronisation des coffres…',
    'quantumroot.syncVaults': 'Synchroniser les coffres',
    'quantumroot.openVaults': 'Ouvrir les coffres',
    'quantumroot.liveNow':
      'Disponible maintenant : dépenses normales, suivi du solde et récupération de BCH par Quantum Lock.',
    'quantumroot.guidedNow':
      'Guidé maintenant : choisissez une clé d’approbation, verrouillez-la dans Quantum Lock, puis dépensez la pièce correspondante.',
    'quantumroot.back': 'Retour',
    'quantumroot.close': 'Fermer',
    'quantumroot.workspaceRefreshFailed':
      'Échec de l’actualisation de l’espace de travail',
    'quantumroot.noVaults':
      'Aucun coffre Quantumroot n’a encore été dérivé. Synchronisez les coffres pour les provisionner à partir des index d’adresses existants du portefeuille.',
    'quantumroot.refreshing':
      'Actualisation des soldes et de l’état des UTXO. Les coffres restent disponibles pendant la synchronisation.',
    'quantumroot.vaultNumber': 'Coffre n° {id}',
    'quantumroot.checkingBalances': 'Vérification des soldes…',
    'quantumroot.readyToRecover': '{count} prêt(s) à récupérer',
    'quantumroot.fundedStatus': 'Financé',
    'quantumroot.noFundsYet': 'Aucun fonds pour le moment',
  },
  ko: {
    'quantumroot.subtitle': '하나의 볼트에 있는 두 개의 지출 경로',
    'quantumroot.betaProduction': '베타 프로덕션',
    'quantumroot.betaTitle': 'Quantumroot 베타 프로덕션',
    'quantumroot.livePreview': '실시간 미리 보기',
    'quantumroot.mainnetPreview':
      '활성화 전까지 Mainnet 미리 보기가 표시됩니다.',
    'quantumroot.activeWorkspace':
      '베타 프로덕션 Quantumroot 흐름을 위한 활성 작업 공간입니다.',
    'quantumroot.mainnetAhead':
      'Quantumroot가 활성화 전에 Mainnet에 표시됩니다. 레이아웃은 사용할 수 있지만 주요 작업은 {date}까지 비활성화됩니다.',
    'quantumroot.activeNetwork':
      '이 네트워크에서 Quantumroot가 활성화되었습니다. 아래 작업 공간에서 일반 지출 경로와 양자 안전 복구 경로를 관리하세요.',
    'quantumroot.trackedBalance': '추적 잔액',
    'quantumroot.vaults': '볼트',
    'quantumroot.funded': '{count}개 자금 지원됨',
    'quantumroot.syncingVaults': '볼트 동기화 중…',
    'quantumroot.syncVaults': '볼트 동기화',
    'quantumroot.openVaults': '볼트 열기',
    'quantumroot.liveNow':
      '현재 사용 가능: 일반 지출, 잔액 추적 및 Quantum Lock BCH 복구.',
    'quantumroot.guidedNow':
      '현재 안내됨: 승인 키를 하나 선택해 Quantum Lock에 잠근 다음 일치하는 코인을 사용하세요.',
    'quantumroot.back': '뒤로',
    'quantumroot.close': '닫기',
    'quantumroot.workspaceRefreshFailed': '작업 공간을 새로 고치지 못했습니다',
    'quantumroot.noVaults':
      '아직 파생된 Quantumroot 볼트가 없습니다. 볼트를 동기화하여 기존 지갑 주소 인덱스에 생성하세요.',
    'quantumroot.refreshing':
      '잔액과 UTXO 상태를 새로 고치는 중입니다. 동기화가 끝날 때까지 볼트를 사용할 수 있습니다.',
    'quantumroot.vaultNumber': '볼트 #{id}',
    'quantumroot.checkingBalances': '잔액 확인 중…',
    'quantumroot.readyToRecover': '{count}개 복구 가능',
    'quantumroot.fundedStatus': '자금 지원됨',
    'quantumroot.noFundsYet': '아직 자금 없음',
  },
  ja: {
    'quantumroot.subtitle': '1 つの保管庫に 2 つの支出レーン',
    'quantumroot.betaProduction': 'ベータプロダクション',
    'quantumroot.betaTitle': 'Quantumroot ベータプロダクション',
    'quantumroot.livePreview': 'ライブプレビュー',
    'quantumroot.mainnetPreview':
      '有効化前は Mainnet のプレビューが表示されます。',
    'quantumroot.activeWorkspace':
      'ベータプロダクション Quantumroot フローのアクティブなワークスペースです。',
    'quantumroot.mainnetAhead':
      'Quantumroot は有効化前の Mainnet に表示されます。レイアウトは利用できますが、主な操作は {date} まで無効です。',
    'quantumroot.activeNetwork':
      'このネットワークでは Quantumroot が有効です。下のワークスペースで通常の支出レーンと量子安全な復元レーンを管理してください。',
    'quantumroot.trackedBalance': '追跡残高',
    'quantumroot.vaults': '保管庫',
    'quantumroot.funded': '{count} 件の入金済み',
    'quantumroot.syncingVaults': '保管庫を同期中…',
    'quantumroot.syncVaults': '保管庫を同期',
    'quantumroot.openVaults': '保管庫を開く',
    'quantumroot.liveNow':
      '現在利用可能：通常の支出、残高追跡、Quantum Lock BCH の復元。',
    'quantumroot.guidedNow':
      'ガイド付き：承認キーを 1 つ選び、Quantum Lock にロックしてから対応するコインを支出します。',
    'quantumroot.back': '戻る',
    'quantumroot.close': '閉じる',
    'quantumroot.workspaceRefreshFailed':
      'ワークスペースを更新できませんでした',
    'quantumroot.noVaults':
      '導出された Quantumroot 保管庫はまだありません。保管庫を同期して、既存のウォレットアドレスインデックスに作成してください。',
    'quantumroot.refreshing':
      '残高と UTXO 状態を更新中です。同期が完了するまで保管庫は利用できます。',
    'quantumroot.vaultNumber': '保管庫 #{id}',
    'quantumroot.checkingBalances': '残高を確認中…',
    'quantumroot.readyToRecover': '{count} 件が復元可能',
    'quantumroot.fundedStatus': '入金済み',
    'quantumroot.noFundsYet': '資金はまだありません',
  },
  ru: {
    'quantumroot.subtitle': 'Два пути расходования в одном хранилище',
    'quantumroot.betaProduction': 'Бета-версия в работе',
    'quantumroot.betaTitle': 'Quantumroot в бета-версии',
    'quantumroot.livePreview': 'Предпросмотр в реальном времени',
    'quantumroot.mainnetPreview':
      'Предпросмотр Mainnet остаётся видимым до активации.',
    'quantumroot.activeWorkspace':
      'Активная рабочая область бета-процесса Quantumroot.',
    'quantumroot.mainnetAhead':
      'Quantumroot отображается в Mainnet до активации. Макет доступен, но основные действия отключены до {date}.',
    'quantumroot.activeNetwork':
      'Quantumroot активен в этой сети. Используйте рабочую область ниже для управления обычным путём расходования и квантово-безопасным путём восстановления.',
    'quantumroot.trackedBalance': 'Отслеживаемый баланс',
    'quantumroot.vaults': 'Хранилища',
    'quantumroot.funded': 'Пополнено: {count}',
    'quantumroot.syncingVaults': 'Синхронизация хранилищ…',
    'quantumroot.syncVaults': 'Синхронизировать хранилища',
    'quantumroot.openVaults': 'Открыть хранилища',
    'quantumroot.liveNow':
      'Уже доступно: обычные расходы, отслеживание баланса и восстановление BCH через Quantum Lock.',
    'quantumroot.guidedNow':
      'С подсказками: выберите ключ подтверждения, заблокируйте его в Quantum Lock и потратьте соответствующую монету.',
    'quantumroot.back': 'Назад',
    'quantumroot.close': 'Закрыть',
    'quantumroot.workspaceRefreshFailed': 'Не удалось обновить рабочую область',
    'quantumroot.noVaults':
      'Производные хранилища Quantumroot ещё не созданы. Синхронизируйте хранилища, чтобы подготовить их для существующих индексов адресов кошелька.',
    'quantumroot.refreshing':
      'Обновление балансов и состояния UTXO. Хранилища остаются доступны во время синхронизации.',
    'quantumroot.vaultNumber': 'Хранилище №{id}',
    'quantumroot.checkingBalances': 'Проверка балансов…',
    'quantumroot.readyToRecover': 'Готово к восстановлению: {count}',
    'quantumroot.fundedStatus': 'Пополнено',
    'quantumroot.noFundsYet': 'Средств пока нет',
  },
  'ha-NG': {
    'quantumroot.subtitle': 'Hanyoyin kashe kuɗi biyu a vault guda',
    'quantumroot.betaProduction': 'Beta production',
    'quantumroot.betaTitle': 'Quantumroot Beta Production',
    'quantumroot.livePreview': 'Dubawa kai tsaye',
    'quantumroot.mainnetPreview': 'Dubawar Mainnet tana nan kafin kunnawa.',
    'quantumroot.activeWorkspace':
      'Wurin aiki mai aiki don tsarin Quantumroot na beta production.',
    'quantumroot.mainnetAhead':
      'Quantumroot yana bayyana a Mainnet kafin kunnawa. Tsarin yana samuwa, amma manyan ayyuka za su kasance a kashe har zuwa {date}.',
    'quantumroot.activeNetwork':
      'Quantumroot yana aiki a wannan hanyar sadarwa. Yi amfani da wurin aiki da ke ƙasa don sarrafa hanyar kashe kuɗi ta yau da kullum da hanyar dawo da kuɗi mai jure quantum.',
    'quantumroot.trackedBalance': 'Ma’aunin da ake sa ido',
    'quantumroot.vaults': 'Vaults',
    'quantumroot.funded': '{count} an ba su kuɗi',
    'quantumroot.syncingVaults': 'Ana daidaita vaults…',
    'quantumroot.syncVaults': 'Daidaita vaults',
    'quantumroot.openVaults': 'Buɗe vaults',
    'quantumroot.liveNow':
      'Yana samuwa yanzu: kashe kuɗi na yau da kullum, sa ido kan ma’auni da dawo da BCH ta Quantum Lock.',
    'quantumroot.guidedNow':
      'Yana da jagora: zaɓi approval key guda, kulle shi a Quantum Lock, sannan ka kashe coin ɗin da ya dace.',
    'quantumroot.back': 'Koma',
    'quantumroot.close': 'Rufe',
    'quantumroot.workspaceRefreshFailed': 'An kasa sabunta wurin aiki',
    'quantumroot.noVaults':
      'Har yanzu ba a samo Quantumroot vault ba. Daidaita vaults don samar da su ga index na adireshin wallet da ke akwai.',
    'quantumroot.refreshing':
      'Ana sabunta ma’auni da yanayin UTXO. Vaults za su kasance a amfani yayin da daidaitawa ke ƙarewa.',
    'quantumroot.vaultNumber': 'Vault #{id}',
    'quantumroot.checkingBalances': 'Ana duba ma’auni…',
    'quantumroot.readyToRecover': '{count} suna shirye don dawo da su',
    'quantumroot.fundedStatus': 'An ba da kuɗi',
    'quantumroot.noFundsYet': 'Babu kuɗi tukuna',
  },
};
