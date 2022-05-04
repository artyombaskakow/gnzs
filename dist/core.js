define([
  "jquery",
  "moment",
  "lib/components/base/modal",
  "underscore",
  "https://cdn.jsdelivr.net/npm/object-hash@3.0.0/dist/object_hash.min.js",
], function ($, moment, Modal, _, hash) {
  const API_URL = "https://core-api.gnzs.ru/public";
  const API_ACCOUNT_INFO = `account/info`;
  const API_ACCOUNT_NOTIFICATIONS = "account/notifications";
  const API_STATUS = "status/current";
  const API_ONSAVE = "onsave";
  const API_SETTINGS = "settings";

  const SETTINGS_SPINNER_ID = "gnzs-widget-description__spinner";

  const CORE = {
    widget: null,
    descriptionHtml: "",
    statusLocaleData: null,
    tariff: null,

    _getDataStorageKey: () => "GNZS_ACCOUNT_DATA",
    _getNotificationsStorageKey: () => "GNZS_NOTIFICATIONS",
    _getPaidStatusNotifStorageKey: (widget) => {
      return `GNZS_WIDGET_STATUS_NOTIFICATION_${widget.GNZS_WIDGET_ID}`;
    },

    /**
     * Метод, вызываемый при инициализации виджета, который может загрузить настройки из БД (флаг loadSettigns),
     * загрузить кэшированные в амо настройки (флаг useCacheSettings)
     * @param {*} widget
     * @param {*} param1
     * @returns
     */
    async onInit(widget, { loadSettigns, useCacheSettings, isChargeable }) {
      let settings = null;
      let tariffObj = null;
      this.updateAccountData(widget);

      console.log("init hash", this._getAccountHash());

      // получение уведомлений по аккаунту
      this.getAccountNotifications(widget);

      // получение активации виджета
      if (isChargeable) {
        const { isActive, tariff } = await this.getPaidStatus(widget);
        tariffObj = tariff;

        if (!isActive) {
          throw new Error(`GNZS WIDGET ${widget.GNZS_WIDGET_ID}: widget is not active`);
        }
      }

      if (loadSettigns || useCacheSettings) {
        settings = await this.getWidgetSettings(widget, loadSettigns, useCacheSettings);
      }

      return { tariff: tariffObj, settings };
    },

    /**
     * Метод, вызываемый на колбеке onSave виджета, который валидирует данные (телефон) и сохраняет их при необходимости в БД
     * @param {object} data - объект настроек
     * @param {boolean} needSaveSettings - нужно ли сохранять настройки по виджету в core
     * @returns
     */
    async onSave(widget, data, needSaveSettings) {
      const { name, login, personal_mobile } = AMOCRM.constant("user");
      const sendData = {
        userName: name,
        userEmail: login,
        userPhone: personal_mobile,
        fields: {
          phone: data.fields.phone,
        },
      };

      const route = needSaveSettings ? API_ONSAVE + "?save-settings=1" : API_ONSAVE;

      if (needSaveSettings) {
        sendData.fields.cached_settings = data.cached_settings;
      }

      try {
        await this._apiPost(widget, route, sendData);
      } catch (e) {
        const errorText = e?.responseJSON?.message;

        if (errorText?.length) {
          new Modal().showError(errorText, false);
        } else {
          new Modal().showError("Непредвиденная ошибка", false);
        }

        return false;
      }

      await this.saveAccountData(widget);

      return true;
    },

    /**
     * Получение уведомлений по аккаунту
     */
    async getAccountNotifications(widget) {
      const key = this._getNotificationsStorageKey();
      const keyLoading = `${key}_LOADING`;
      const isCached = this._getCookie(key);
      const isProcessing = this._getCookie(keyLoading);

      if (isCached || isProcessing) {
        return;
      }

      this._setCookie(keyLoading, 1, 3 * 60);

      const {
        notifications,
        cacheMinutes,
        showNextWatingSeconds = 3,
      } = await this._apiGet(widget, API_ACCOUNT_NOTIFICATIONS);

      const isAdmin = this._currUserIsAdmin();
      this._setCookie(key, 1, cacheMinutes * 60);

      if (notifications?.length) {
        for (const notif of notifications) {
          const { id, header, text, link, cachingMin = 3, onlyForAdmin = false } = notif;
          const cookieName = `gnzs_notification_${id}`;
          const isShowed = this._getCookie(cookieName);

          if (isShowed || (onlyForAdmin && !isAdmin)) continue; // не показываем уведомление

          this._showErrorNotification(header, text, link);
          this._setCookie(cookieName, 1, cachingMin * 60);
          await this._wait(showNextWatingSeconds);
        }
      }
    },

    /**
     * Функция обновления данных из AMOCRM.constant на основе проверки хэша (если не было измненений, то запрос не отправится)
     */
    async updateAccountData(widget) {
      const key = this._getDataStorageKey();
      const keyProcessing = `${key}_PROCESSING`;

      const isProcessing = this._getCookie(keyProcessing);
      let cache = this._getCookie(key);
      if (cache?.length) cache = JSON.parse(cache);

      if (isProcessing) {
        return; // другой виджет уже работает. завершаем
      }

      if (cache?._hash?.length) {
        const currHash = this._getAccountHash();

        if (currHash == cache._hash) {
          this._setCookie(key, JSON.stringify(cache), cache.cacheMinutes * 60);
          return;
        }
      }

      this._setCookie(keyProcessing, 1, 3 * 60);
      await this.saveAccountData(widget);
    },

    /**
     * Сохранение данных аккаунта на сервере и кэширование в куки
     */
    async saveAccountData(widget) {
      const { _hash, cacheMinutes } = await this._apiPost(
        widget,
        API_ACCOUNT_INFO,
        this._accountData()
      );

      const key = this._getDataStorageKey();
      const cache = { _hash, cacheMinutes };
      this._setCookie(key, JSON.stringify(cache), cacheMinutes * 60);
    },

    async getWidgetSettings(widget, loadSettigns, useCacheSettings) {
      if (!loadSettigns && !useCacheSettings) return null;

      if (useCacheSettings) {
        let settingsData = widget.params?.cached_settings;

        if (settingsData && typeof settingsData == "string") {
          settingsData = JSON.parse(settingsData);
        }

        if (!_.isEmpty(settingsData)) {
          return settingsData;
        }
      }

      if (loadSettigns) {
        return await this._apiGet(widget, API_SETTINGS);
      }

      return null;
    },

    /**
     * Получение данных об активации виджета
     */
    async getPaidStatus(widget) {
      const isSettingsPage = AMOCRM.data.current_entity == "widgetsSettings" ? 1 : 0;

      const searchParams = [];
      if (isSettingsPage) searchParams.push("with-description-html=1");

      const url = `${API_STATUS}/${widget.GNZS_WIDGET_ID}?${searchParams.join("&")}`;

      const resp = await this._apiGet(widget, url);
      if (!resp) {
        console.debug(`GNZS WIDGET ${widget.GNZS_WIDGET_ID} - no installation data`);
        return;
      }

      const { isActive, notification, tariff, statusLocaleData = {}, descriptionHtml = "" } = resp;
      this.descriptionHtml = descriptionHtml;

      if (notification?.text?.length) {
        const key = this._getPaidStatusNotifStorageKey(widget);
        const isCached = this._getCookie(key);
        if (!isCached) {
          this._showErrorNotification(notification.header, notification.text, notification.link);
          this._setCookie(key, 1, notification.cachingMin * 60);
        }
      }

      return { isActive, tariff, descriptionHtml };
    },

    /**
     * Метод при открытии модального окна настроек.
     * @param {boolean} showSpinner - показывать ли spinner загрузи
     */
    async onSettings(widget, showSpinner = false) {
      if (showSpinner) {
        $("#widget_settings__fields_wrapper").before(this._getSettingsSpinnerHtml());
      }

      if (!this.descriptionHtml?.length) {
        const { descriptionHtml } = await this.getPaidStatus(widget);
        this.descriptionHtml = descriptionHtml;
      }

      $("#widget_settings__fields_wrapper").before(this.descriptionHtml);
    },

    /**
     * Метод при окончании инициализации загрузки (скрытие spinner'а, если showSpinner = true в onSettings)
     */
    async onSettingsInitialized() {
      $(`#${SETTINGS_SPINNER_ID}`).hide();
    },

    /**
     * Получение JWT-токена для iframe-приложений
     */
    async getJwt(widget) {
      return new Promise((resolve) => {
        widget.$authorizedAjax({
          url: `${API_URL}/jwt/${widget.GNZS_WIDGET_ID}`,
          method: "GET",
          dataType: "json",
          headers: this._getHeaders(widget),
          success: (resp) => resolve(resp),
          error: (resp) => reject(resp),
        });
      });
    },

    _getSettingsSpinnerHtml() {
      return `<div id="${SETTINGS_SPINNER_ID}" style="width: 100%;height: 100%;position: absolute;z-index: 999;background: white; display: flex;justify-content: center;padding-top: 150px;"><span class="spinner-icon"></span></div>`;
    },

    _getNextTimestamp(minutes) {
      return moment().add(minutes, "m").unix();
    },

    _apiGet(widget, route) {
      return this._send(widget, route, null, "GET");
    },

    _apiPost(widget, route, data) {
      return this._send(widget, route, data, "POST");
    },

    _getHeaders(widget) {
      return {
        "Content-Type": "application/json",
        "X-Widget-Id": widget.GNZS_WIDGET_ID,
        "X-Account-id": AMOCRM.constant("account").id,
        "X-User-id": AMOCRM.constant("user").id,
        "X-Language": AMOCRM.lang_id,
        "X-Top-Level-Domain": AMOCRM.constant("account").top_level_domain,
      };
    },

    _currUserIsAdmin() {
      return AMOCRM.constant("managers")[AMOCRM.constant("user").id].is_admin == "Y";
    },

    _send(widget, route, data, method = "POST") {
      return new Promise((resolve, reject) => {
        const account = AMOCRM.constant("account");

        const isWidgetInstalled = widget.params?.active == "Y";
        const $func = isWidgetInstalled ? widget.$authorizedAjax.bind(widget) : $.ajax;
        const headers = this._getHeaders(widget);

        if (!isWidgetInstalled) {
          headers["X-Widget-Installation"] = account.id + "_" + widget.GNZS_WIDGET_ID;
        }

        $func({
          url: `${API_URL}/${route}`,
          method,
          headers,
          dataType: "json",
          data: data ? JSON.stringify(data) : {},
          success: (resp) => resolve(resp),
          error: (resp) => reject(resp),
        });
      });
    },

    _accountData(isActive) {
      const accountJson = JSON.stringify(AMOCRM.constant("account"));
      const account = JSON.parse(accountJson); // копируем
      //удаляем лишние данные
      delete account.users;
      delete account.cf;
      delete account.predefined_cf;

      const _hash = this._getAccountHash();
      const managers = AMOCRM.constant("managers");
      const _users_count = Object.values(managers).filter((m) => m.active).length;
      const _users_avatars = Object.values(managers)
        .filter((m) => m.active && m.avatar?.length)
        .map((m) => ({ avatar: m.avatar, id: +m.id }));

      return { ...account, _users_count, _users_avatars, _hash, _is_active: isActive };
    },

    _wait: (seconds) => {
      return new Promise((resolve) => setTimeout(() => resolve(), seconds * 1000));
    },

    _getAccountHash() {
      const data = {
        account: AMOCRM.constant("account"),
        groups: AMOCRM.constant("groups"),
        managers: AMOCRM.constant("managers"),
      };
      return hash(data);
    },

    _setCookie(name, value, expiredSeconds) {
      const options = {
        path: "/",
        secure: true,
        "max-age": expiredSeconds,
      };

      let updatedCookie = encodeURIComponent(name) + "=" + encodeURIComponent(value);

      for (let optionKey in options) {
        updatedCookie += "; " + optionKey;
        let optionValue = options[optionKey];
        if (optionValue !== true) {
          updatedCookie += "=" + optionValue;
        }
      }

      document.cookie = updatedCookie;
    },

    _getCookie(name) {
      let matches = document.cookie.match(
        new RegExp("(?:^|; )" + name.replace(/([\.$?*|{}\(\)\[\]\\\/\+^])/g, "\\$1") + "=([^;]*)")
      );
      return matches ? decodeURIComponent(matches[1]) : undefined;
    },

    _deleteCookie(name) {
      this._setCookie(name, "", -1);
    },

    _showErrorNotification(header, text, link = "") {
      AMOCRM.notifications.add_error({
        header: header,
        text: text,
        date: new Date().getTime(),
        link: link,
      });
    },
  };

  return CORE;
});
