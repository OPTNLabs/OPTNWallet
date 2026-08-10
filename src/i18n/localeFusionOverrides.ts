import type { BaseLocale, SupportedLocale } from './types';

type AddedLocale = Exclude<SupportedLocale, BaseLocale>;

export const localeFusionOverrides: Partial<
  Record<AddedLocale, Record<string, string>>
> = {
  'pt-BR': {
    'fusion.handshaking': 'Negociando…',
    'fusion.handshakeOk': 'Negociação OK ✓',
    'fusion.failed': 'Falhou ✗',
    'fusion.privacy': 'Privacidade',
    'fusion.summary':
      'O CashFusion combina UTXOs de vários participantes em uma única transação, rompendo os vínculos entre entradas e saídas no histórico da blockchain. É não custodial — seus fundos nunca deixam seu controle.',
    'fusion.hide': 'Ocultar',
    'fusion.howWorks': 'Como funciona?',
    'fusion.step1': '1. Entrada no pool.',
    'fusion.step1Text':
      'Sua carteira anuncia ao servidor os UTXOs que deseja fundir.',
    'fusion.step2': '2. Assinatura cega.',
    'fusion.step2Text':
      'Os participantes geram endereços de saída cegos e trocam assinaturas cegas — ninguém descobre o mapeamento entre entradas e saídas.',
    'fusion.step3': '3. Envio reservado.',
    'fusion.step3Text':
      'Cada participante envia a transação via Tor ou conexão direta. O servidor monta a transação final.',
    'fusion.step4': '4. Transmissão.',
    'fusion.step4Text':
      'Todos os participantes transmitem a transação construída em conjunto.',
    'fusion.enabled': 'CashFusion ativado',
    'fusion.disable': 'Desativar',
    'fusion.enable': 'Ativar',
    'fusion.choose': 'Escolha como fundir:',
    'fusion.serverMode': 'Fundir agora usando o servidor CashFusion',
    'fusion.p2pMode': 'Fusion P2P',
    'fusion.serverModeLabel': 'Fusion por servidor',
    'fusion.serverModeDescription':
      'Funda via servidor CashFusion. Faz a fusão automática quando ativado.',
    'fusion.p2pModeLabel': 'Fusion P2P',
    'fusion.p2pModeDescription':
      'Sem servidor — pares via Nostr + Tor. Faz a fusão automática quando ativado. Ativar desliga a Fusion por servidor.',
    'fusion.enableServer': 'Ativar Fusion por servidor',
    'fusion.enableP2p': 'Ativar Fusion P2P',
    'fusion.experimentalPending': 'Experimental — ainda pendente: {items}.',
    'fusion.or': 'ou',
    'fusion.coinjoinBoth': 'Ambos executam um CoinJoin real.',
    'fusion.protocolNote':
      'As etapas 1–4 são executadas de ponta a ponta pelo caminho do servidor: a carteira entra em um pool, troca assinaturas cegas, envia via Tor e transmite o CoinJoin montado. A Fusion P2P executa a mesma rodada sem servidor, usando Nostr e Tor. Alguns itens experimentais de reforço da carteira ainda estão pendentes, mas suas próprias saídas são verificadas antes da assinatura, portanto uma rodada inválida falha com segurança.',
    'fusion.coinjoinAnyNetwork':
      'O caminho do servidor e a Fusion P2P executam CoinJoins reais em qualquer rede. Alguns itens de reforço da carteira ainda estão pendentes, mas cada rodada verifica suas próprias saídas antes da assinatura e falha com segurança.',
    'fusion.nowDescription':
      'CoinJoin pelo servidor configurado em Servidores. Requer Tor e pelo menos 2 participantes em um nível.',
    'fusion.now': 'Fundir agora',
    'fusion.fusing': 'Fundindo…',
    'fusion.openWallet': 'Abra uma carteira para executar uma rodada P2P.',
    'fusion.servers': 'Servidores Fusion',
    'fusion.autoTry': 'Automático — tentar cada um até obter resposta',
    'fusion.selected': '● selecionado',
    'fusion.addPlaceholder':
      'Adicionar servidor — host:porta (por exemplo, fusion.example.com:8789)',
    'fusion.queryAuto': 'Consultar (automático)',
    'fusion.queryServer': 'Consultar servidor',
    'fusion.mobileUnsupported':
      'O CashFusion precisa de uma conexão TCP bruta, que um navegador mobile/web não pode abrir. Disponível no app para desktop.',
    'fusion.remoteTorRequired':
      'Este é um servidor remoto, então o Tor é obrigatório — mas nenhum proxy Tor foi encontrado. Inicie o Tor acima ou a consulta será recusada.',
    'fusion.torOff':
      'O Tor está desligado. Consultas remotas de Fusion serão recusadas — ative o Tor acima ou use um servidor localhost.',
    'fusion.connectingTor': 'Conectando via Tor{port}.',
    'fusion.serverParameters': 'Parâmetros do servidor (ao vivo)',
    'fusion.poolTiers': 'Níveis do pool',
    'fusion.componentsPlayer': 'Componentes / participante',
    'fusion.componentFeeRate': 'Taxa de comissão do componente',
    'fusion.excessFeeRange': 'Faixa de comissão excedente',
    'fusion.tiers': 'Níveis',
    'fusion.more': 'mais',
    'fusion.donation': 'Doação',
    'fusion.fewServers':
      'O CashFusion tem intencionalmente poucos servidores públicos — um conjunto de anonimato maior em menos servidores é melhor do que se espalhar demais. Adicione seu próprio servidor ou um servidor da comunidade acima.',
    'fusion.fused': 'Fundido ✓ — txid {txid}',
    'fusion.busy':
      'Uma rodada de Fusion já está em execução para esta carteira.',
    'fusion.syncingCoins':
      'Sincronizando moedas da carteira — tente novamente em instantes.',
    'fusion.noEligibleCoins': 'Nenhuma moeda pode ser fundida agora.',
    'fusion.cooldown': 'Aguardando o intervalo da fusão automática.',
  },
  vi: {
    'fusion.handshaking': 'Đang bắt tay…',
    'fusion.handshakeOk': 'Bắt tay OK ✓',
    'fusion.failed': 'Thất bại ✗',
    'fusion.privacy': 'Riêng tư',
    'fusion.summary':
      'CashFusion kết hợp UTXO từ nhiều người tham gia thành một giao dịch, phá liên kết lịch sử blockchain giữa đầu vào và đầu ra. Đây là giao thức không lưu ký — tiền luôn nằm trong quyền kiểm soát của bạn.',
    'fusion.hide': 'Ẩn',
    'fusion.howWorks': 'Hoạt động như thế nào?',
    'fusion.step1': '1. Tham gia pool.',
    'fusion.step1Text': 'Ví thông báo cho máy chủ các UTXO muốn hợp nhất.',
    'fusion.step2': '2. Ký mù.',
    'fusion.step2Text':
      'Người tham gia tạo địa chỉ đầu ra mù và trao đổi chữ ký mù — không ai biết ánh xạ đầu vào–đầu ra.',
    'fusion.step3': '3. Gửi kín.',
    'fusion.step3Text':
      'Mỗi người tham gia gửi giao dịch qua Tor hoặc kết nối trực tiếp. Máy chủ lắp ráp giao dịch cuối.',
    'fusion.step4': '4. Phát giao dịch.',
    'fusion.step4Text':
      'Tất cả người tham gia phát giao dịch được xây dựng chung.',
    'fusion.enabled': 'Đã bật CashFusion',
    'fusion.disable': 'Tắt',
    'fusion.enable': 'Bật',
    'fusion.choose': 'Chọn cách hợp nhất:',
    'fusion.serverMode': 'Hợp nhất ngay bằng máy chủ CashFusion',
    'fusion.p2pMode': 'Fusion P2P',
    'fusion.serverModeLabel': 'Fusion qua máy chủ',
    'fusion.serverModeDescription':
      'Hợp nhất qua máy chủ CashFusion. Tự động hợp nhất khi bật.',
    'fusion.p2pModeLabel': 'Fusion P2P',
    'fusion.p2pModeDescription':
      'Không máy chủ — peer qua Nostr + Tor. Tự động hợp nhất khi bật. Bật mục này sẽ tắt Fusion qua máy chủ.',
    'fusion.enableServer': 'Bật Fusion qua máy chủ',
    'fusion.enableP2p': 'Bật Fusion P2P',
    'fusion.experimentalPending': 'Thử nghiệm — vẫn đang chờ: {items}.',
    'fusion.or': 'hoặc',
    'fusion.coinjoinBoth': 'Cả hai đều chạy CoinJoin thật.',
    'fusion.protocolNote':
      'Các bước 1–4 chạy trọn vẹn trên đường máy chủ: ví tham gia pool, trao đổi chữ ký mù, gửi qua Tor và phát CoinJoin đã lắp ráp. Fusion P2P chạy cùng vòng mà không cần máy chủ qua Nostr và Tor. Một số mục tăng cường ví thử nghiệm vẫn đang chờ, nhưng đầu ra của bạn được xác minh trước khi ký nên vòng không hợp lệ sẽ thất bại an toàn.',
    'fusion.coinjoinAnyNetwork':
      'Cả đường máy chủ và Fusion P2P đều chạy CoinJoin thật trên mọi mạng. Một số mục tăng cường ví vẫn đang chờ, nhưng mỗi vòng xác minh đầu ra của bạn trước khi ký nên sẽ thất bại an toàn.',
    'fusion.nowDescription':
      'CoinJoin qua máy chủ đã cấu hình trong mục Máy chủ. Cần Tor và ít nhất 2 người chơi cùng nhóm.',
    'fusion.now': 'Hợp nhất ngay',
    'fusion.fusing': 'Đang hợp nhất…',
    'fusion.openWallet': 'Mở ví để chạy vòng P2P.',
    'fusion.servers': 'Máy chủ Fusion',
    'fusion.autoTry': 'Tự động — thử từng máy chủ đến khi có phản hồi',
    'fusion.selected': '● đã chọn',
    'fusion.addPlaceholder':
      'Thêm máy chủ — host:cổng (ví dụ fusion.example.com:8789)',
    'fusion.queryAuto': 'Truy vấn (tự động)',
    'fusion.queryServer': 'Truy vấn máy chủ',
    'fusion.mobileUnsupported':
      'CashFusion cần kết nối TCP thô mà trình duyệt mobile/web không thể mở. Có sẵn trong ứng dụng desktop.',
    'fusion.remoteTorRequired':
      'Đây là máy chủ từ xa nên cần Tor — nhưng không tìm thấy proxy Tor. Khởi động Tor ở trên hoặc truy vấn sẽ bị từ chối.',
    'fusion.torOff':
      'Tor đang tắt. Truy vấn Fusion từ xa sẽ bị từ chối — bật Tor ở trên hoặc dùng máy chủ localhost.',
    'fusion.connectingTor': 'Đang kết nối qua Tor{port}.',
    'fusion.serverParameters': 'Tham số máy chủ (trực tiếp)',
    'fusion.poolTiers': 'Nhóm pool',
    'fusion.componentsPlayer': 'Thành phần / người chơi',
    'fusion.componentFeeRate': 'Mức phí thành phần',
    'fusion.excessFeeRange': 'Phạm vi phí dư',
    'fusion.tiers': 'Nhóm',
    'fusion.more': 'thêm',
    'fusion.donation': 'Đóng góp',
    'fusion.fewServers':
      'CashFusion cố ý có ít máy chủ công khai — một tập ẩn danh lớn hơn trên ít máy chủ tốt hơn việc dàn trải quá mỏng. Hãy thêm máy chủ của bạn hoặc máy chủ cộng đồng ở trên.',
    'fusion.fused': 'Đã hợp nhất ✓ — txid {txid}',
    'fusion.busy': 'Ví này đã có một vòng Fusion đang chạy.',
    'fusion.syncingCoins':
      'Đang đồng bộ coin của ví — hãy thử lại sau giây lát.',
    'fusion.noEligibleCoins': 'Hiện không có coin đủ điều kiện để hợp nhất.',
    'fusion.cooldown': 'Đang chờ thời gian nghỉ của hợp nhất tự động.',
  },
  'zh-TW': {
    'fusion.handshaking': '交握中…',
    'fusion.handshakeOk': '交握成功 ✓',
    'fusion.failed': '失敗 ✗',
    'fusion.privacy': '隱私',
    'fusion.summary':
      'CashFusion 將多位參與者的 UTXO 結合成一筆交易，打破區塊鏈歷史中輸入與輸出之間的連結。這是非託管協定，資金始終由您控制。',
    'fusion.hide': '隱藏',
    'fusion.howWorks': '如何運作？',
    'fusion.step1': '1. 加入池。',
    'fusion.step1Text': '您的錢包會向伺服器公告要融合的 UTXO。',
    'fusion.step2': '2. 盲簽章。',
    'fusion.step2Text':
      '參與者產生盲化輸出地址並交換盲簽章 — 沒有人能得知輸入到輸出的對應關係。',
    'fusion.step3': '3. 隱密提交。',
    'fusion.step3Text':
      '每位參與者透過 Tor 或直接連線提交交易。伺服器會組合最終交易。',
    'fusion.step4': '4. 廣播。',
    'fusion.step4Text': '所有參與者廣播共同建立的交易。',
    'fusion.enabled': 'CashFusion 已啟用',
    'fusion.disable': '停用',
    'fusion.enable': '啟用',
    'fusion.choose': '選擇融合方式：',
    'fusion.serverMode': '使用 CashFusion 伺服器立即融合',
    'fusion.p2pMode': 'P2P Fusion',
    'fusion.serverModeLabel': '伺服器 Fusion',
    'fusion.serverModeDescription':
      '透過 CashFusion 伺服器融合。開啟後會自動融合。',
    'fusion.p2pModeLabel': 'P2P Fusion',
    'fusion.p2pModeDescription':
      '無伺服器 — 透過 Nostr + Tor 連線節點。開啟後會自動融合；開啟此項會關閉伺服器 Fusion。',
    'fusion.enableServer': '啟用伺服器 Fusion',
    'fusion.enableP2p': '啟用 P2P Fusion',
    'fusion.experimentalPending': '實驗性功能 — 尚待完成：{items}。',
    'fusion.or': '或',
    'fusion.coinjoinBoth': '兩者都會執行真正的 CoinJoin。',
    'fusion.protocolNote':
      '步驟 1–4 會在伺服器路徑上完整執行：錢包加入池、交換盲簽章、透過 Tor 提交，並廣播組合後的 CoinJoin。P2P Fusion 透過 Nostr 與 Tor 在沒有伺服器的情況下執行相同回合。部分實驗性的錢包強化項目仍在等待，但簽署前會驗證您自己的輸出，因此無效回合會安全失敗。',
    'fusion.coinjoinAnyNetwork':
      '伺服器路徑與 P2P Fusion 都能在任何網路上執行真正的 CoinJoin。部分錢包強化項目仍在等待，但每回合都會在簽署前驗證自己的輸出，因此會安全失敗。',
    'fusion.nowDescription':
      '透過「伺服器」中設定的伺服器執行 CoinJoin。需要 Tor，以及同一層級至少 2 位參與者。',
    'fusion.now': '立即融合',
    'fusion.fusing': '融合中…',
    'fusion.openWallet': '開啟錢包以執行 P2P 回合。',
    'fusion.servers': 'Fusion 伺服器',
    'fusion.autoTry': '自動 — 依序嘗試直到伺服器回應',
    'fusion.selected': '● 已選取',
    'fusion.addPlaceholder':
      '新增伺服器 — 主機:連接埠（例如 fusion.example.com:8789）',
    'fusion.queryAuto': '查詢（自動）',
    'fusion.queryServer': '查詢伺服器',
    'fusion.mobileUnsupported':
      'CashFusion 需要行動／網頁瀏覽器無法開啟的原始 TCP 連線。桌面應用程式可使用。',
    'fusion.remoteTorRequired':
      '這是遠端伺服器，因此需要 Tor — 但找不到 Tor Proxy。請在上方啟動 Tor，否則查詢會被拒絕。',
    'fusion.torOff':
      'Tor 已關閉。遠端 Fusion 查詢會被拒絕 — 請在上方啟用 Tor，或使用 localhost 伺服器。',
    'fusion.connectingTor': '透過 Tor{port} 連線。',
    'fusion.serverParameters': '伺服器參數（即時）',
    'fusion.poolTiers': '池層級',
    'fusion.componentsPlayer': '元件／參與者',
    'fusion.componentFeeRate': '元件費率',
    'fusion.excessFeeRange': '額外費用範圍',
    'fusion.tiers': '層級',
    'fusion.more': '更多',
    'fusion.donation': '捐款',
    'fusion.fewServers':
      'CashFusion 刻意維持少量公開伺服器 — 在較少伺服器上形成更大的匿名集合，比過度分散更好。請在上方新增自己的伺服器或社群伺服器。',
    'fusion.fused': '已融合 ✓ — txid {txid}',
    'fusion.busy': '此錢包已有 Fusion 回合正在執行。',
    'fusion.syncingCoins': '正在同步錢包硬幣 — 請稍後再試。',
    'fusion.noEligibleCoins': '目前沒有符合融合條件的硬幣。',
    'fusion.cooldown': '正在等待自動融合冷卻時間。',
  },
  fr: {
    'fusion.handshaking': 'Négociation…',
    'fusion.handshakeOk': 'Négociation réussie ✓',
    'fusion.failed': 'Échec ✗',
    'fusion.privacy': 'Confidentialité',
    'fusion.summary':
      'CashFusion combine les UTXO de nombreux participants en une seule transaction, rompant les liens entre entrées et sorties dans l’historique de la blockchain. Il est non dépositaire : vos fonds restent sous votre contrôle.',
    'fusion.hide': 'Masquer',
    'fusion.howWorks': 'Comment cela fonctionne-t-il ?',
    'fusion.step1': '1. Rejoindre le pool.',
    'fusion.step1Text':
      'Votre portefeuille annonce au serveur les UTXO qu’il souhaite fusionner.',
    'fusion.step2': '2. Signature aveugle.',
    'fusion.step2Text':
      'Les participants génèrent des adresses de sortie aveugles et échangent des signatures aveugles : personne ne découvre la correspondance entre entrées et sorties.',
    'fusion.step3': '3. Soumission discrète.',
    'fusion.step3Text':
      'Chaque participant soumet la transaction via Tor ou une connexion directe. Le serveur assemble la transaction finale.',
    'fusion.step4': '4. Diffusion.',
    'fusion.step4Text':
      'Tous les participants diffusent la transaction construite ensemble.',
    'fusion.enabled': 'CashFusion activé',
    'fusion.disable': 'Désactiver',
    'fusion.enable': 'Activer',
    'fusion.choose': 'Choisissez le mode de fusion :',
    'fusion.serverMode': 'Fusionner maintenant avec un serveur CashFusion',
    'fusion.p2pMode': 'Fusion P2P',
    'fusion.serverModeLabel': 'Fusion par serveur',
    'fusion.serverModeDescription':
      'Fusionne via un serveur CashFusion. Fusion automatique lorsque l’option est activée.',
    'fusion.p2pModeLabel': 'Fusion P2P',
    'fusion.p2pModeDescription':
      'Sans serveur — pairs via Nostr + Tor. Fusion automatique lorsque l’option est activée. L’activation désactive la fusion par serveur.',
    'fusion.enableServer': 'Activer la fusion par serveur',
    'fusion.enableP2p': 'Activer la Fusion P2P',
    'fusion.experimentalPending': 'Expérimental — encore en attente : {items}.',
    'fusion.or': 'ou',
    'fusion.coinjoinBoth': 'Les deux exécutent un véritable CoinJoin.',
    'fusion.protocolNote':
      'Les étapes 1 à 4 s’exécutent de bout en bout sur le parcours serveur : le portefeuille rejoint un pool, échange des signatures aveugles, soumet via Tor et diffuse le CoinJoin assemblé. La Fusion P2P exécute le même tour sans serveur via Nostr et Tor. Certains renforcements expérimentaux du portefeuille sont encore en attente, mais vos sorties sont vérifiées avant la signature : un tour invalide échoue donc en toute sécurité.',
    'fusion.coinjoinAnyNetwork':
      'Le parcours serveur et la Fusion P2P exécutent de vrais CoinJoin sur n’importe quel réseau. Certains renforcements du portefeuille sont encore en attente, mais chaque tour vérifie vos sorties avant la signature et échoue en toute sécurité.',
    'fusion.nowDescription':
      'CoinJoin via le serveur configuré dans Serveurs. Nécessite Tor et au moins 2 participants dans un niveau.',
    'fusion.now': 'Fusionner maintenant',
    'fusion.fusing': 'Fusion en cours…',
    'fusion.openWallet': 'Ouvrez un portefeuille pour lancer un tour P2P.',
    'fusion.servers': 'Serveurs Fusion',
    'fusion.autoTry':
      'Automatique — essayer chacun jusqu’à obtenir une réponse',
    'fusion.selected': '● sélectionné',
    'fusion.addPlaceholder':
      'Ajouter un serveur — hôte:port (ex. fusion.example.com:8789)',
    'fusion.queryAuto': 'Interroger (automatique)',
    'fusion.queryServer': 'Interroger le serveur',
    'fusion.mobileUnsupported':
      'CashFusion nécessite une connexion TCP brute qu’un navigateur mobile/web ne peut pas ouvrir. Disponible dans l’application de bureau.',
    'fusion.remoteTorRequired':
      'Il s’agit d’un serveur distant, Tor est donc requis — mais aucun proxy Tor n’a été trouvé. Démarrez Tor ci-dessus, sinon la requête sera refusée.',
    'fusion.torOff':
      'Tor est désactivé. Les requêtes Fusion distantes seront refusées — activez Tor ci-dessus ou utilisez un serveur localhost.',
    'fusion.connectingTor': 'Connexion via Tor{port}.',
    'fusion.serverParameters': 'Paramètres du serveur (en direct)',
    'fusion.poolTiers': 'Niveaux du pool',
    'fusion.componentsPlayer': 'Composants / participant',
    'fusion.componentFeeRate': 'Taux de frais du composant',
    'fusion.excessFeeRange': 'Plage de frais excédentaires',
    'fusion.tiers': 'Niveaux',
    'fusion.more': 'plus',
    'fusion.donation': 'Don',
    'fusion.fewServers':
      'CashFusion compte volontairement peu de serveurs publics : un ensemble d’anonymat plus grand sur moins de serveurs vaut mieux qu’une dispersion excessive. Ajoutez votre serveur ou un serveur communautaire ci-dessus.',
    'fusion.fused': 'Fusionnée ✓ — txid {txid}',
    'fusion.busy': 'Un tour de Fusion est déjà en cours pour ce portefeuille.',
    'fusion.syncingCoins':
      'Synchronisation des pièces du portefeuille — réessayez dans un instant.',
    'fusion.noEligibleCoins':
      'Aucune pièce ne peut être fusionnée pour le moment.',
    'fusion.cooldown':
      'En attente du délai de refroidissement de la fusion automatique.',
  },
  ko: {
    'fusion.handshaking': '핸드셰이크 중…',
    'fusion.handshakeOk': '핸드셰이크 성공 ✓',
    'fusion.failed': '실패 ✗',
    'fusion.privacy': '개인정보 보호',
    'fusion.summary':
      'CashFusion은 여러 참여자의 UTXO를 하나의 거래로 결합해 블록체인 기록에서 입력과 출력의 연결을 끊습니다. 비수탁 방식이므로 자금은 항상 사용자가 통제합니다.',
    'fusion.hide': '숨기기',
    'fusion.howWorks': '어떻게 작동하나요?',
    'fusion.step1': '1. 풀 참여.',
    'fusion.step1Text': '지갑이 융합할 UTXO를 서버에 알립니다.',
    'fusion.step2': '2. 블라인드 서명.',
    'fusion.step2Text':
      '참여자들이 블라인드 출력 주소를 만들고 블라인드 서명을 교환하므로 입력과 출력의 연결을 아무도 알 수 없습니다.',
    'fusion.step3': '3. 비공개 제출.',
    'fusion.step3Text':
      '각 참여자가 Tor 또는 직접 연결로 거래를 제출합니다. 서버가 최종 거래를 조립합니다.',
    'fusion.step4': '4. 브로드캐스트.',
    'fusion.step4Text': '모든 참여자가 함께 만든 거래를 브로드캐스트합니다.',
    'fusion.enabled': 'CashFusion 활성화됨',
    'fusion.disable': '비활성화',
    'fusion.enable': '활성화',
    'fusion.choose': '융합 방법 선택:',
    'fusion.serverMode': 'CashFusion 서버로 지금 융합',
    'fusion.p2pMode': 'P2P Fusion',
    'fusion.serverModeLabel': '서버 Fusion',
    'fusion.serverModeDescription':
      'CashFusion 서버를 통해 융합합니다. 켜져 있으면 자동으로 융합합니다.',
    'fusion.p2pModeLabel': 'P2P Fusion',
    'fusion.p2pModeDescription':
      '서버 없음 — Nostr + Tor를 통한 피어 연결. 켜져 있으면 자동으로 융합하며, 켜면 서버 Fusion이 꺼집니다.',
    'fusion.enableServer': '서버 Fusion 활성화',
    'fusion.enableP2p': 'P2P Fusion 활성화',
    'fusion.experimentalPending': '실험적 기능 — 아직 대기 중: {items}.',
    'fusion.or': '또는',
    'fusion.coinjoinBoth': '둘 다 실제 CoinJoin을 실행합니다.',
    'fusion.protocolNote':
      '1~4단계는 서버 경로에서 끝까지 실행됩니다. 지갑이 풀에 참여하고 블라인드 서명을 교환한 뒤 Tor로 제출하고 조립된 CoinJoin을 브로드캐스트합니다. P2P Fusion은 Nostr와 Tor를 통해 서버 없이 같은 라운드를 실행합니다. 일부 실험적 지갑 강화 항목은 아직 대기 중이지만, 서명 전에 사용자의 출력을 확인하므로 잘못된 라운드는 안전하게 실패합니다.',
    'fusion.coinjoinAnyNetwork':
      '서버 경로와 P2P Fusion은 모든 네트워크에서 실제 CoinJoin을 실행합니다. 일부 지갑 강화 항목은 아직 대기 중이지만 각 라운드가 서명 전에 사용자 출력을 확인하므로 안전하게 실패합니다.',
    'fusion.nowDescription':
      '서버 설정에 구성된 서버를 통한 CoinJoin입니다. Tor와 같은 티어의 참가자 2명 이상이 필요합니다.',
    'fusion.now': '지금 융합',
    'fusion.fusing': '융합 중…',
    'fusion.openWallet': 'P2P 라운드를 실행하려면 지갑을 여세요.',
    'fusion.servers': 'Fusion 서버',
    'fusion.autoTry': '자동 — 응답할 때까지 각각 시도',
    'fusion.selected': '● 선택됨',
    'fusion.addPlaceholder':
      '서버 추가 — 호스트:포트(예: fusion.example.com:8789)',
    'fusion.queryAuto': '조회(자동)',
    'fusion.queryServer': '서버 조회',
    'fusion.mobileUnsupported':
      'CashFusion은 모바일/웹 브라우저가 열 수 없는 원시 TCP 연결이 필요합니다. 데스크톱 앱에서 사용할 수 있습니다.',
    'fusion.remoteTorRequired':
      '원격 서버이므로 Tor가 필요하지만 Tor 프록시를 찾지 못했습니다. 위에서 Tor를 시작하거나 조회가 거부됩니다.',
    'fusion.torOff':
      'Tor가 꺼져 있습니다. 원격 Fusion 조회가 거부됩니다. 위에서 Tor를 켜거나 localhost 서버를 사용하세요.',
    'fusion.connectingTor': 'Tor{port}를 통해 연결 중입니다.',
    'fusion.serverParameters': '서버 매개변수(실시간)',
    'fusion.poolTiers': '풀 티어',
    'fusion.componentsPlayer': '구성 요소 / 참가자',
    'fusion.componentFeeRate': '구성 요소 수수료율',
    'fusion.excessFeeRange': '초과 수수료 범위',
    'fusion.tiers': '티어',
    'fusion.more': '더 보기',
    'fusion.donation': '기부',
    'fusion.fewServers':
      'CashFusion은 의도적으로 공개 서버를 적게 운영합니다. 적은 서버에서 더 큰 익명 집합을 만드는 것이 지나치게 분산하는 것보다 좋습니다. 위에 개인 또는 커뮤니티 서버를 추가하세요.',
    'fusion.fused': '융합됨 ✓ — txid {txid}',
    'fusion.busy': '이 지갑에서 Fusion 라운드가 이미 실행 중입니다.',
    'fusion.syncingCoins':
      '지갑 코인 동기화 중입니다. 잠시 후 다시 시도하세요.',
    'fusion.noEligibleCoins': '지금 융합할 수 있는 코인이 없습니다.',
    'fusion.cooldown': '자동 융합 대기 시간 중입니다.',
  },
  ja: {
    'fusion.handshaking': 'ハンドシェイク中…',
    'fusion.handshakeOk': 'ハンドシェイク成功 ✓',
    'fusion.failed': '失敗 ✗',
    'fusion.privacy': 'プライバシー',
    'fusion.summary':
      'CashFusion は複数参加者の UTXO を 1 つの取引に結合し、ブロックチェーン履歴で入力と出力のつながりを切ります。非カストディアルなので、資金は常にあなたの管理下にあります。',
    'fusion.hide': '隠す',
    'fusion.howWorks': 'どのように動作しますか？',
    'fusion.step1': '1. プールに参加。',
    'fusion.step1Text': 'ウォレットが融合したい UTXO をサーバーに通知します。',
    'fusion.step2': '2. ブラインド署名。',
    'fusion.step2Text':
      '参加者がブラインド出力アドレスを生成してブラインド署名を交換するため、誰も入力と出力の対応を知りません。',
    'fusion.step3': '3. 非公開の送信。',
    'fusion.step3Text':
      '各参加者が Tor または直接接続で取引を送信し、サーバーが最終取引を組み立てます。',
    'fusion.step4': '4. ブロードキャスト。',
    'fusion.step4Text':
      'すべての参加者が共同で作成した取引をブロードキャストします。',
    'fusion.enabled': 'CashFusion 有効',
    'fusion.disable': '無効化',
    'fusion.enable': '有効化',
    'fusion.choose': '融合方法を選択：',
    'fusion.serverMode': 'CashFusion サーバーで今すぐ融合',
    'fusion.p2pMode': 'P2P Fusion',
    'fusion.serverModeLabel': 'サーバー Fusion',
    'fusion.serverModeDescription':
      'CashFusion サーバー経由で融合します。有効時は自動で融合します。',
    'fusion.p2pModeLabel': 'P2P Fusion',
    'fusion.p2pModeDescription':
      'サーバーなし — Nostr + Tor 経由でピア接続。有効時は自動で融合し、これを有効にするとサーバー Fusion は無効になります。',
    'fusion.enableServer': 'サーバー Fusion を有効化',
    'fusion.enableP2p': 'P2P Fusion を有効化',
    'fusion.experimentalPending': '実験的 — まだ保留中：{items}。',
    'fusion.or': 'または',
    'fusion.coinjoinBoth': 'どちらも本物の CoinJoin を実行します。',
    'fusion.protocolNote':
      'ステップ 1〜4 はサーバー経路で最後まで実行されます。ウォレットがプールに参加し、ブラインド署名を交換し、Tor 経由で送信して組み立てた CoinJoin をブロードキャストします。P2P Fusion は Nostr と Tor を使い、サーバーなしで同じラウンドを実行します。一部の実験的なウォレット強化項目は保留中ですが、署名前に自分の出力を確認するため、無効なラウンドは安全に失敗します。',
    'fusion.coinjoinAnyNetwork':
      'サーバー経路と P2P Fusion は、どのネットワークでも本物の CoinJoin を実行します。一部のウォレット強化項目は保留中ですが、各ラウンドで署名前に自分の出力を確認するため、安全に失敗します。',
    'fusion.nowDescription':
      '「サーバー」で設定したサーバー経由の CoinJoin。同じティアに Tor と 2 人以上の参加者が必要です。',
    'fusion.now': '今すぐ融合',
    'fusion.fusing': '融合中…',
    'fusion.openWallet':
      'P2P ラウンドを実行するにはウォレットを開いてください。',
    'fusion.servers': 'Fusion サーバー',
    'fusion.autoTry': '自動 — 応答するまで順番に試す',
    'fusion.selected': '● 選択済み',
    'fusion.addPlaceholder':
      'サーバーを追加 — ホスト:ポート（例 fusion.example.com:8789）',
    'fusion.queryAuto': 'クエリ（自動）',
    'fusion.queryServer': 'サーバーにクエリ',
    'fusion.mobileUnsupported':
      'CashFusion にはモバイル／ウェブブラウザーでは開けない生の TCP 接続が必要です。デスクトップアプリで利用できます。',
    'fusion.remoteTorRequired':
      'リモートサーバーなので Tor が必要ですが、Tor プロキシが見つかりません。上で Tor を起動しないとクエリは拒否されます。',
    'fusion.torOff':
      'Tor がオフです。リモート Fusion クエリは拒否されます。上で Tor を有効にするか localhost サーバーを使用してください。',
    'fusion.connectingTor': 'Tor{port} 経由で接続中。',
    'fusion.serverParameters': 'サーバーパラメーター（ライブ）',
    'fusion.poolTiers': 'プールのティア',
    'fusion.componentsPlayer': 'コンポーネント／参加者',
    'fusion.componentFeeRate': 'コンポーネント手数料率',
    'fusion.excessFeeRange': '超過手数料の範囲',
    'fusion.tiers': 'ティア',
    'fusion.more': 'さらに表示',
    'fusion.donation': '寄付',
    'fusion.fewServers':
      'CashFusion は意図的に公開サーバーを少数にしています。少数のサーバーで大きな匿名集合を作る方が、薄く分散するより優れています。上で自分のサーバーまたはコミュニティサーバーを追加してください。',
    'fusion.fused': '融合済み ✓ — txid {txid}',
    'fusion.busy': 'このウォレットでは Fusion ラウンドがすでに実行中です。',
    'fusion.syncingCoins':
      'ウォレットのコインを同期中です。少し待ってから再試行してください。',
    'fusion.noEligibleCoins': '現在、融合できるコインはありません。',
    'fusion.cooldown': '自動融合のクールダウンを待っています。',
  },
  ru: {
    'fusion.handshaking': 'Установка связи…',
    'fusion.handshakeOk': 'Связь установлена ✓',
    'fusion.failed': 'Ошибка ✗',
    'fusion.privacy': 'Конфиденциальность',
    'fusion.summary':
      'CashFusion объединяет UTXO многих участников в одну транзакцию, разрывая связи между входами и выходами в истории блокчейна. Это некастодиальный протокол: средства остаются под вашим контролем.',
    'fusion.hide': 'Скрыть',
    'fusion.howWorks': 'Как это работает?',
    'fusion.step1': '1. Вход в пул.',
    'fusion.step1Text':
      'Кошелёк сообщает серверу, какие UTXO он хочет объединить.',
    'fusion.step2': '2. Слепая подпись.',
    'fusion.step2Text':
      'Участники создают слепые адреса выходов и обмениваются слепыми подписями — никто не узнаёт соответствие входов и выходов.',
    'fusion.step3': '3. Скрытая отправка.',
    'fusion.step3Text':
      'Каждый участник отправляет транзакцию через Tor или напрямую. Сервер собирает итоговую транзакцию.',
    'fusion.step4': '4. Трансляция.',
    'fusion.step4Text':
      'Все участники транслируют совместно созданную транзакцию.',
    'fusion.enabled': 'CashFusion включён',
    'fusion.disable': 'Отключить',
    'fusion.enable': 'Включить',
    'fusion.choose': 'Выберите способ объединения:',
    'fusion.serverMode': 'Объединить сейчас через сервер CashFusion',
    'fusion.p2pMode': 'P2P Fusion',
    'fusion.serverModeLabel': 'Fusion через сервер',
    'fusion.serverModeDescription':
      'Объединение через сервер CashFusion. При включении выполняется автоматически.',
    'fusion.p2pModeLabel': 'P2P Fusion',
    'fusion.p2pModeDescription':
      'Без сервера — пиры через Nostr + Tor. При включении выполняется автоматически и отключает Fusion через сервер.',
    'fusion.enableServer': 'Включить Fusion через сервер',
    'fusion.enableP2p': 'Включить P2P Fusion',
    'fusion.experimentalPending':
      'Экспериментальная функция — ещё ожидается: {items}.',
    'fusion.or': 'или',
    'fusion.coinjoinBoth': 'Оба режима выполняют настоящий CoinJoin.',
    'fusion.protocolNote':
      'Шаги 1–4 полностью выполняются через сервер: кошелёк входит в пул, обменивается слепыми подписями, отправляет через Tor и транслирует собранный CoinJoin. P2P Fusion выполняет тот же раунд без сервера через Nostr и Tor. Некоторые экспериментальные усиления кошелька ещё ожидаются, но ваши выходы проверяются до подписи, поэтому недействительный раунд безопасно завершается ошибкой.',
    'fusion.coinjoinAnyNetwork':
      'И серверный путь, и P2P Fusion выполняют настоящие CoinJoin в любой сети. Некоторые усиления кошелька ещё ожидаются, но каждый раунд проверяет ваши выходы до подписи и безопасно завершается при ошибке.',
    'fusion.nowDescription':
      'CoinJoin через сервер, настроенный в разделе «Серверы». Нужны Tor и минимум 2 участника в одном уровне.',
    'fusion.now': 'Объединить сейчас',
    'fusion.fusing': 'Объединение…',
    'fusion.openWallet': 'Откройте кошелёк, чтобы запустить раунд P2P.',
    'fusion.servers': 'Серверы Fusion',
    'fusion.autoTry': 'Автоматически — пробовать каждый до ответа',
    'fusion.selected': '● выбран',
    'fusion.addPlaceholder':
      'Добавить сервер — хост:порт (например fusion.example.com:8789)',
    'fusion.queryAuto': 'Запрос (автоматически)',
    'fusion.queryServer': 'Запросить сервер',
    'fusion.mobileUnsupported':
      'CashFusion требует необработанное TCP-соединение, которое мобильный или веб-браузер открыть не может. Доступно в приложении для компьютера.',
    'fusion.remoteTorRequired':
      'Это удалённый сервер, поэтому нужен Tor, но прокси Tor не найден. Запустите Tor выше, иначе запрос будет отклонён.',
    'fusion.torOff':
      'Tor выключен. Удалённые запросы Fusion будут отклонены — включите Tor выше или используйте сервер localhost.',
    'fusion.connectingTor': 'Подключение через Tor{port}.',
    'fusion.serverParameters': 'Параметры сервера (текущие)',
    'fusion.poolTiers': 'Уровни пула',
    'fusion.componentsPlayer': 'Компоненты / участник',
    'fusion.componentFeeRate': 'Ставка комиссии компонента',
    'fusion.excessFeeRange': 'Диапазон дополнительной комиссии',
    'fusion.tiers': 'Уровни',
    'fusion.more': 'ещё',
    'fusion.donation': 'Пожертвование',
    'fusion.fewServers':
      'У CashFusion намеренно мало публичных серверов: большой набор анонимности на меньшем числе серверов лучше, чем чрезмерное распределение. Добавьте выше свой сервер или сервер сообщества.',
    'fusion.fused': 'Объединено ✓ — txid {txid}',
    'fusion.busy': 'Для этого кошелька уже выполняется раунд Fusion.',
    'fusion.syncingCoins':
      'Синхронизация монет кошелька — повторите попытку через мгновение.',
    'fusion.noEligibleCoins': 'Сейчас нет монет, подходящих для объединения.',
    'fusion.cooldown': 'Ожидание паузы автоматического объединения.',
  },
  'ha-NG': {
    'fusion.handshaking': 'Ana kulla haɗi…',
    'fusion.handshakeOk': 'An kulla haɗi ✓',
    'fusion.failed': 'Ya gaza ✗',
    'fusion.privacy': 'Sirri',
    'fusion.summary':
      'CashFusion yana haɗa UTXO na masu shiga da yawa zuwa ciniki guda, yana karya alaƙar tarihin blockchain tsakanin shigarwa da fitarwa. Ba ya riƙe kuɗinka — kuɗinka suna ƙarƙashin ikonka koyaushe.',
    'fusion.hide': 'Ɓoye',
    'fusion.howWorks': 'Yaya yake aiki?',
    'fusion.step1': '1. Shiga pool.',
    'fusion.step1Text':
      'Wallet ɗinka yana sanar da server UTXO ɗin da yake son haɗawa.',
    'fusion.step2': '2. Sa hannu a ɓoye.',
    'fusion.step2Text':
      'Masu shiga suna ƙirƙirar adireshin fitarwa a ɓoye kuma su musanya sa hannun ɓoye — babu wanda ya san alaƙar shigarwa da fitarwa.',
    'fusion.step3': '3. Aika a ɓoye.',
    'fusion.step3Text':
      'Kowane mai shiga yana aika ciniki ta Tor ko haɗin kai tsaye. Server yana haɗa cinikin ƙarshe.',
    'fusion.step4': '4. Watsawa.',
    'fusion.step4Text':
      'Dukkan masu shiga suna watsa cinikin da aka gina tare.',
    'fusion.enabled': 'CashFusion yana kunne',
    'fusion.disable': 'Kashe',
    'fusion.enable': 'Kunna',
    'fusion.choose': 'Zaɓi yadda za a haɗa:',
    'fusion.serverMode': 'Haɗa yanzu ta amfani da CashFusion server',
    'fusion.p2pMode': 'P2P Fusion',
    'fusion.serverModeLabel': 'Fusion ta server',
    'fusion.serverModeDescription':
      'Haɗa ta CashFusion server. Yana haɗawa kai tsaye idan yana kunne.',
    'fusion.p2pModeLabel': 'P2P Fusion',
    'fusion.p2pModeDescription':
      'Babu server — peers ta Nostr + Tor. Yana haɗawa kai tsaye idan yana kunne. Kunna wannan yana kashe Fusion ta server.',
    'fusion.enableServer': 'Kunna Fusion ta server',
    'fusion.enableP2p': 'Kunna P2P Fusion',
    'fusion.experimentalPending': 'Na gwaji — har yanzu ana jira: {items}.',
    'fusion.or': 'ko',
    'fusion.coinjoinBoth': 'Dukansu suna gudanar da CoinJoin na gaske.',
    'fusion.protocolNote':
      'Matakai 1–4 suna gudana gaba ɗaya ta hanyar server: wallet yana shiga pool, yana musanya sa hannun ɓoye, yana aika ta Tor sannan ya watsa CoinJoin da aka haɗa. P2P Fusion yana gudanar da zagaye ɗaya ba tare da server ba ta Nostr da Tor. Wasu abubuwan ƙarfafa wallet na gwaji har yanzu ana jira, amma ana tabbatar da fitarwarka kafin sa hannu, don haka zagaye mara inganci yana ƙare lafiya.',
    'fusion.coinjoinAnyNetwork':
      'Hanyar server da P2P Fusion duk suna gudanar da CoinJoin na gaske a kowace hanyar sadarwa. Wasu abubuwan ƙarfafa wallet har yanzu ana jira, amma kowane zagaye yana tabbatar da fitarwarka kafin sa hannu, don haka yana ƙare lafiya idan akwai kuskure.',
    'fusion.nowDescription':
      'CoinJoin ta server da aka saita a Servers. Yana buƙatar Tor da aƙalla masu wasa 2 a rukuni ɗaya.',
    'fusion.now': 'Haɗa yanzu',
    'fusion.fusing': 'Ana haɗawa…',
    'fusion.openWallet': 'Buɗe wallet don gudanar da zagayen P2P.',
    'fusion.servers': 'Fusion servers',
    'fusion.autoTry': 'Kai tsaye — gwada kowane ɗaya har sai ya amsa',
    'fusion.selected': '● an zaɓa',
    'fusion.addPlaceholder':
      'Ƙara server — host:port (misali fusion.example.com:8789)',
    'fusion.queryAuto': 'Tambaya (kai tsaye)',
    'fusion.queryServer': 'Tambayi server',
    'fusion.mobileUnsupported':
      'CashFusion yana buƙatar haɗin TCP na asali wanda mobile/web browser ba zai iya buɗewa ba. Yana samuwa a manhajar kwamfuta.',
    'fusion.remoteTorRequired':
      'Wannan server ne na nesa, don haka ana buƙatar Tor — amma ba a sami Tor proxy ba. Fara Tor a sama, ko za a ƙi tambayar.',
    'fusion.torOff':
      'Tor a kashe yake. Za a ƙi tambayoyin Fusion na nesa — kunna Tor a sama ko yi amfani da localhost server.',
    'fusion.connectingTor': 'Ana haɗawa ta Tor{port}.',
    'fusion.serverParameters': 'Ma’aunin server (kai tsaye)',
    'fusion.poolTiers': 'Matakan pool',
    'fusion.componentsPlayer': 'Abubuwa / ɗan wasa',
    'fusion.componentFeeRate': 'Adadin kuɗin abu',
    'fusion.excessFeeRange': 'Rangwamen ƙarin kuɗi',
    'fusion.tiers': 'Matakai',
    'fusion.more': 'ƙari',
    'fusion.donation': 'Gudummawa',
    'fusion.fewServers':
      'CashFusion yana da ƴan public servers da gangan — babban rukunin ɓoyewa a kan ƴan servers ya fi rarrabawa sosai. Ƙara server ɗinka ko na al’umma a sama.',
    'fusion.fused': 'An haɗa ✓ — txid {txid}',
    'fusion.busy': 'Akwai zagayen Fusion da ke gudana tuni ga wannan wallet.',
    'fusion.syncingCoins':
      'Ana daidaita tsabar wallet — sake gwadawa nan da ɗan lokaci.',
    'fusion.noEligibleCoins': 'Babu tsabar da ta dace da haɗawa yanzu.',
    'fusion.cooldown': 'Ana jiran lokacin hutun haɗawa kai tsaye.',
  },
};
