odoo.define('mail.chat_client_action', function (require) {
"use strict";

var chat_manager = require('mail.chat_manager');
var composer = require('mail.composer');
var ChatThread = require('mail.ChatThread');

var config = require('web.config');
var ControlPanelMixin = require('web.ControlPanelMixin');
var core = require('web.core');
var data = require('web.data');
var Dialog = require('web.Dialog');
var framework = require('web.framework');
var Model = require('web.Model');

var pyeval = require('web.pyeval');
var SearchView = require('web.SearchView');
var Widget = require('web.Widget');

var QWeb = core.qweb;
var _t = core._t;

/**
 * Widget : Invite People to Channel Dialog
 *
 * Popup containing a 'many2many_tags' custom input to select multiple partners.
 * Search user according to the input, and trigger event when selection is validated.
 **/
var PartnerInviteDialog = Dialog.extend({
    dialog_title: _t('Invite people'),
    template: "mail.PartnerInviteDialog",
    init: function(parent, title, channel_id){
        this.channel_id = channel_id;

        this._super(parent, {
            title: title,
            size: "medium",
            buttons: [{
                text: _t("Invite"),
                close: true,
                classes: "btn-primary",
                click: _.bind(this.on_click_add, this),
            }],
        });
        this.PartnersModel = new Model('res.partner');
    },
    start: function(){
        var self = this;
        this.$input = this.$('.o_mail_chat_partner_invite_input');
        this.$input.select2({
            width: '100%',
            allowClear: true,
            multiple: true,
            formatResult: function(item) {
                var status = QWeb.render('mail.chat.UserStatus', {status: item.im_status});
                return $('<span>').text(item.text).prepend(status);
            },
            query: function (query) {
                self.PartnersModel.call('im_search', [query.term, 20]).then(function(result){
                    var data = [];
                    _.each(result, function(partner){
                        partner.text = partner.name;
                        data.push(partner);
                    });
                    query.callback({results: data});
                });
            }
        });
        return this._super.apply(this, arguments);
    },
    on_click_add: function(){
        var self = this;
        var data = this.$input.select2('data');
        if(data.length >= 1){
            var ChannelModel = new Model('mail.channel');
            return ChannelModel.call('channel_invite', [], {ids : [this.channel_id], partner_ids: _.pluck(data, 'id')})
                .then(function(){
                    var names = _.escape(_.pluck(data, 'text').join(', '));
                    var notification = _.str.sprintf(_t('You added <b>%s</b> to the conversation.'), names);
                    self.do_notify(_t('New people'), notification);
                });
        }
    },
});

var ChatAction = Widget.extend(ControlPanelMixin, {
    template: 'mail.client_action',

    events: {
        "click .o_mail_chat_channel_item": function (event) {
            event.preventDefault();
            var channel_id = this.$(event.currentTarget).data('channel-id');
            this.set_channel(chat_manager.get_channel(channel_id));
        },
        "click .o_mail_sidebar_title .o_add": function (event) {
            event.preventDefault();
            var type = $(event.target).data("type");
            this.$('.o_mail_add_channel[data-type=' + type + ']')
                .show()
                .find("input").focus();
        },
        "blur .o_mail_add_channel input": function () {
            this.$('.o_mail_add_channel')
                .hide();
        },
        "click .o_mail_partner_unpin": function (event) {
            event.stopPropagation();
            var channel_id = $(event.target).data("channel-id");
            this.unsubscribe_from_channel(chat_manager.get_channel(channel_id));
        },
        "click .o_snackbar_undo": function (event) {
            event.preventDefault();
            var channel = this.channel;
            this.$snackbar.remove();
            this.clear_needactions_def.then(function (msgs_ids) {
                chat_manager.undo_mark_as_read(msgs_ids, channel);
            });
        },
        "click .o_mail_annoying_notification_bar .fa-close": function (event) {
            this.$(".o_mail_annoying_notification_bar").slideUp();
        },
        "click .o_mail_request_permission": function (event) {
            event.preventDefault();
            this.$(".o_mail_annoying_notification_bar").slideUp();
            window.Notification.requestPermission();
        },
    },

    on_attach_callback: function () {
        if (this.channel) {
            this.thread.scroll_to({offset: this.channels_scrolltop[this.channel.id]});
        }
    },
    on_detach_callback: function () {
        this.channels_scrolltop[this.channel.id] = this.thread.get_scrolltop();
    },

    init: function(parent, action, options) {
        this._super.apply(this, arguments);
        this.action_manager = parent;
        this.domain = [];
        this.action = action;
        this.options = options || {};
        this.channels_scrolltop = {};
        this.throttled_render_sidebar = _.throttle(this.render_sidebar.bind(this), 100, { leading: false });
        this.notification_bar = (window.Notification && window.Notification.permission === "default");
    },

    willStart: function () {
        return chat_manager.is_ready;
    },

    start: function() {
        var self = this;

        // create searchview
        var options = {
            $buttons: $("<div>"),
            action: this.action,
            disable_groupby: true,
        };
        var dataset = new data.DataSetSearch(this, 'mail.message');
        var view_id = (this.action && this.action.search_view_id && this.action.search_view_id[0]) || false;
        var default_channel_id = this.options.active_id ||
                                 this.action.context.active_id ||
                                 this.action.params.default_active_id ||
                                 'channel_inbox';
        var default_channel = chat_manager.get_channel(default_channel_id) ||
                              chat_manager.get_channel('channel_inbox');

        this.searchview = new SearchView(this, dataset, view_id, {}, options);
        this.searchview.on('search_data', this, this.on_search);

        this.basic_composer = new composer.BasicComposer(this);
        this.extended_composer = new composer.ExtendedComposer(this);
        this.thread = new ChatThread(this, {
            display_help: true,
            shorten_messages: false,
        });

        this.$buttons = $(QWeb.render("mail.chat.ControlButtons", {}));
        this.$buttons.find('button').css({display:"inline-block"});
        this.$buttons.on('click', '.o_mail_chat_button_invite', this.on_click_button_invite);
        this.$buttons.on('click', '.o_mail_chat_button_detach', this.on_click_button_detach);
        this.$buttons.on('click', '.o_mail_chat_button_unsubscribe', this.on_click_button_unsubscribe);
        this.$buttons.on('click', '.o_mail_chat_button_settings', this.on_click_button_settings);
        this.$buttons.on('click', '.o_mail_toggle_channels', function () {
            self.$('.o_mail_chat_sidebar').slideToggle(200);
        });
        this.$buttons.on('click', '.o_mail_chat_button_mark_read', function () {
            chat_manager.mark_all_as_read();
        });
        this.$buttons.on('click', '.o_mail_chat_button_unstar_all', chat_manager.unstar_all);

        this.thread.on('redirect', this, function (res_model, res_id) {
            chat_manager.redirect(res_model, res_id, this.set_channel.bind(this));
        });
        this.thread.on('redirect_to_channel', this, function (channel_id) {
            chat_manager.join_channel(channel_id).then(this.set_channel.bind(this));
        });
        this.thread.on('load_more_messages', this, this.load_more_messages);
        this.thread.on('mark_as_read', this, function (message_id) {
            chat_manager.mark_as_read([message_id]);
        });
        this.thread.on('toggle_star_status', this, function (message_id) {
            chat_manager.toggle_star_status(message_id);
        });
        this.basic_composer.on('post_message', this, this.on_post_message);
        this.basic_composer.on('input_focused', this, this.on_composer_input_focused);
        this.extended_composer.on('post_message', this, this.on_post_message);
        this.extended_composer.on('input_focused', this, this.on_composer_input_focused);

        var def1 = this.thread.prependTo(this.$('.o_mail_chat_content'));
        var def2 = this.basic_composer.appendTo(this.$('.o_mail_chat_content'));
        var def3 = this.extended_composer.appendTo(this.$('.o_mail_chat_content'));
        var def4 = this.searchview.appendTo($("<div>"));

        this.render_sidebar();

        return $.when(def1, def2, def3, def4)
            .then(this.set_channel.bind(this, default_channel))
            .then(function () {
                chat_manager.bus.on('new_message', self, self.on_new_message);
                chat_manager.bus.on('update_message', self, self.on_update_message);
                chat_manager.bus.on('new_channel', self, self.on_new_channel);
                chat_manager.bus.on('anyone_listening', self, function (channel, query) {
                    query.is_displayed = query.is_displayed || channel.id === self.channel.id;
                });
                chat_manager.bus.on('unsubscribe_from_channel', self, self.render_sidebar);
                chat_manager.bus.on('update_needaction', self, self.throttled_render_sidebar);
                chat_manager.bus.on('update_channel_unread_counter', self, self.throttled_render_sidebar);
                chat_manager.bus.on('update_dm_presence', self, self.throttled_render_sidebar);
            });
    },

    render_sidebar: function () {
        var self = this;
        var $sidebar = $(QWeb.render("mail.chat.Sidebar", {
            active_channel_id: this.channel ? this.channel.id: undefined,
            channels: chat_manager.get_channels(),
            needaction_counter: chat_manager.get_needaction_counter(),
        }));
        this.$(".o_mail_chat_sidebar").html($sidebar.contents());

        this.$('.o_mail_add_channel[data-type=public]').find("input").autocomplete({
            source: function(request, response) {
                self.last_search_val = _.escape(request.term);
                self.do_search_channel(self.last_search_val).done(function(result){
                    result.push({
                        'label':  _.str.sprintf('<strong>'+_t("Create %s")+'</strong>', '<em>"#'+self.last_search_val+'"</em>'),
                        'value': '_create',
                    });
                    response(result);
                });
            },
            select: function(event, ui) {
                if (self.last_search_val) {
                    if (ui.item.value === '_create') {
                        chat_manager.create_channel(self.last_search_val, "public");
                    } else {
                        chat_manager.join_channel(ui.item.id);
                    }
                }
            },
            focus: function(event) {
                event.preventDefault();
            },
            html: true,
        });

        this.$('.o_mail_add_channel[data-type=dm]').find("input").autocomplete({
            source: function(request, response) {
                self.last_search_val = _.escape(request.term);
                self.do_search_partner(self.last_search_val).done(function(result){
                    response(result);
                });
            },
            select: function(event, ui) {
                var partner_id = ui.item.id;
                chat_manager.create_channel(partner_id, "dm");
            },
            focus: function(event) {
                event.preventDefault();
            },
            html: true,
        });

        this.$('.o_mail_add_channel[data-type=private]').find("input").on('keyup', this, function (event) {
            var name = _.escape($(event.target).val());
            if(event.which === $.ui.keyCode.ENTER && name) {
                chat_manager.create_channel(name, "private");
            }
        });
    },

    render_snackbar: function (nb_needactions) {
        this.$snackbar = $(QWeb.render('mail.chat.UndoSnackbar', {
            nb_needactions: nb_needactions,
        }));
        this.$('.o_mail_chat_content').append(this.$snackbar);
        // Hide snackbar after 20s
        var $snackbar = this.$snackbar;
        setTimeout(function() { $snackbar.fadeOut(); }, 20000);
    },

    do_search_channel: function(search_val){
        var Channel = new Model("mail.channel");
        return Channel.call('channel_search_to_join', [search_val]).then(function(result){
            var values = [];
            _.each(result, function(channel){
                var escaped_name = _.escape(channel.name);
                values.push(_.extend(channel, {
                    'value': escaped_name,
                    'label': escaped_name,
                }));
            });
            return values;
        });
    },

    do_search_partner: function (search_val) {
        var Partner = new Model("res.partner");
        return Partner.call('im_search', [search_val, 20]).then(function(result){
            var values = [];
            _.each(result, function(user){
                var escaped_name = _.escape(user.name);
                values.push(_.extend(user, {
                    'value': escaped_name,
                    'label': escaped_name,
                }));
            });
            return values;
        });
    },

    set_channel: function (channel) {
        var self = this;
        // Store scroll position of previous channel
        if (this.channel) {
            this.channels_scrolltop[this.channel.id] = this.thread.get_scrolltop();
        }
        var new_channel_scrolltop = this.channels_scrolltop[channel.id];

        this.channel = channel;
        this.messages_separator_position = undefined; // reset value on channel change
        this.unread_counter = this.channel.unread_counter;
        this.last_seen_message_id = this.channel.last_seen_message_id;
        this.clear_needactions_def = $.Deferred();
        if (this.$snackbar) {
            this.$snackbar.remove();
        }

        this.action.context.active_id = channel.id;
        this.action.context.active_ids = [channel.id];

        return this.fetch_and_render_thread().then(function () {
            // Mark channel's messages as read and clear needactions
            if (channel.type !== 'static') {
                // Display snackbar if needactions have been cleared
                if (channel.needaction_counter > 0) {
                    self.render_snackbar(channel.needaction_counter);
                }
                chat_manager.mark_channel_as_seen(channel);
                self.clear_needactions_def = chat_manager.mark_all_as_read(channel);
            }

            // Update control panel
            self.set("title", '#' + channel.name);
            // Hide 'detach' button in static channels
            self.$buttons
                .find('.o_mail_chat_button_detach')
                .toggle(channel.type !== "static");
            // Hide 'invite', 'unsubscribe' and 'settings' buttons in static channels and DM
            self.$buttons
                .find('.o_mail_chat_button_invite, .o_mail_chat_button_unsubscribe, .o_mail_chat_button_settings')
                .toggle(channel.type !== "dm" && channel.type !== 'static');
            self.$buttons
                .find('.o_mail_chat_button_mark_read')
                .toggle(channel.id === "channel_inbox");
            self.$buttons
                .find('.o_mail_chat_button_unstar_all')
                .toggle(channel.id === "channel_starred");

            self.basic_composer.toggle(channel.type !== 'static' && !channel.mass_mailing);
            self.extended_composer.toggle(channel.type !== 'static' && channel.mass_mailing);

            self.$('.o_mail_chat_channel_item')
                .removeClass('o_active')
                .filter('[data-channel-id=' + channel.id + ']')
                .removeClass('o_unread_message')
                .addClass('o_active');

            var $new_messages_separator = self.$('.o_thread_new_messages_separator');
            if ($new_messages_separator.length) {
                self.thread.$el.scrollTo($new_messages_separator);
            } else {
                self.thread.scroll_to({offset: new_channel_scrolltop});
            }

            // Update control panel before focusing the composer, otherwise focus is on the searchview
            self.update_cp();
            if (!config.device.touch) {
                var composer = channel.mass_mailing ? self.extended_composer : self.basic_composer;
                composer.focus();
            }
            if (config.device.size_class === config.device.SIZES.XS) {
                self.$('.o_mail_chat_sidebar').hide();
            }

            self.action_manager.do_push_state({
                action: self.action.id,
                active_id: self.channel.id,
            });
        });
    },
    unsubscribe_from_channel: function (channel) {
        var self = this;
        chat_manager
            .unsubscribe(channel)
            .then(this.render_sidebar.bind(this))
            .then(this.set_channel.bind(this, chat_manager.get_channel("channel_inbox")))
            .then(function () {
                if (_.contains(['public', 'private'], channel.type)) {
                    var msg = _.str.sprintf(_t('You unsubscribed from <b>%s</b>.'), channel.name);
                    self.do_notify(_t("Unsubscribed"), msg);
                }
                delete self.channels_scrolltop[channel.id];
            });
    },

    get_thread_rendering_options: function (messages) {
        // Compute position of the 'New messages' separator, only once when joining
        // a channel to keep it in the thread when new messages arrive
        if (_.isUndefined(this.messages_separator_position)) {
            var msg_id = this.last_seen_message_id;
            if (!this.unread_counter) {
                this.messages_separator_position = false; // no unread message -> don't display separator
            } else if ((msg_id === false) || !_.findWhere(messages, {id: msg_id})) {
                this.messages_separator_position = 'top'; // all displayed messages are unread
            } else {
                this.messages_separator_position = msg_id; // last read message is msg_id
            }
        }
        return {
            channel_id: this.channel.id,
            display_load_more: !chat_manager.all_history_loaded(this.channel, this.domain),
            display_needactions: this.channel.display_needactions,
            messages_separator_position: this.messages_separator_position,
            squash_close_messages: this.channel.type !== 'static',
            display_empty_channel: !messages.length && !this.domain.length,
            display_no_match: !messages.length && this.domain.length,
            display_subject: this.channel.mass_mailing || this.channel.id === "channel_inbox",
        };
    },

    fetch_and_render_thread: function () {
        var self = this;
        return chat_manager.get_messages({channel_id: this.channel.id, domain: this.domain}).then(function(result) {
            self.thread.render(result, self.get_thread_rendering_options(result));
            self.update_button_status(result.length === 0);
        });
    },

    update_button_status: function (disabled) {
        if (this.channel.id === "channel_inbox") {
            this.$buttons
                .find('.o_mail_chat_button_mark_read')
                .toggleClass('disabled', disabled);
        }
        if (this.channel.id === "channel_starred") {
            this.$buttons
                .find('.o_mail_chat_button_unstar_all')
                .toggleClass('disabled', disabled);
        }
    },

    load_more_messages: function () {
        var self = this;
        var oldest_msg_id = this.$('.o_thread_message').first().data('messageId');
        var oldest_msg_selector = '.o_thread_message[data-message-id="' + oldest_msg_id + '"]';
        var offset = -framework.getPosition(document.querySelector(oldest_msg_selector)).top;
        return chat_manager
            .get_messages({channel_id: this.channel.id, domain: this.domain, load_more: true})
            .then(function(result) {
                if (self.messages_separator_position === 'top') {
                    self.messages_separator_position = undefined; // reset value to re-compute separator position
                }
                self.thread.render(result, self.get_thread_rendering_options(result));
                offset += framework.getPosition(document.querySelector(oldest_msg_selector)).top;
                self.thread.scroll_to({offset: offset});
            });
    },

    update_cp: function () {
        this.update_control_panel({
            breadcrumbs: this.action_manager.get_breadcrumbs(),
            cp_content: {
                $buttons: this.$buttons,
                $searchview: this.searchview.$el,
                $searchview_buttons: this.searchview.$buttons.contents(),
            },
            searchview: this.searchview,
        });
    },

    do_show: function () {
        this._super.apply(this, arguments);
        this.update_cp();
        this.action_manager.do_push_state({
            action: this.action.id,
            active_id: this.channel.id,
        });
    },

    on_search: function (domains) {
        var result = pyeval.sync_eval_domains_and_contexts({
            domains: domains
        });

        this.domain = result.domain;
        this.fetch_and_render_thread();
    },

    on_post_message: function (message) {
        var options = {channel_id: this.channel.id};
        chat_manager
            .post_message(message, options)
            .fail(function () {
                // todo: display notification
            });
    },
    on_new_message: function (message) {
        var self = this;
        if (_.contains(message.channel_ids, this.channel.id)) {
            if (this.channel.type !== 'static') {
                chat_manager.mark_channel_as_seen(this.channel);
            }
            this.fetch_and_render_thread().then(function () {
                self.thread.scroll_to({id: message.id});
            });
        }
        // Re-render sidebar to indicate that there is a new message in the corresponding channels
        this.render_sidebar();
        // Dump scroll position of channels in which the new message arrived
        this.channels_scrolltop = _.omit(this.channels_scrolltop, message.channel_ids);
    },
    on_update_message: function (message) {
        var self = this;
        var current_channel_id = this.channel.id;
        if ((current_channel_id === "channel_starred" && !message.is_starred) ||
            (current_channel_id === "channel_inbox" && !message.is_needaction)) {
            chat_manager.get_messages({channel_id: this.channel.id, domain: this.domain}).then(function (messages) {
                var options = self.get_thread_rendering_options(messages);
                self.thread.remove_message_and_render(message.id, messages, options).then(function () {
                    self.update_button_status(messages.length === 0);
                });
            });
        } else if (_.contains(message.channel_ids, current_channel_id)) {
            this.fetch_and_render_thread();
        }
    },
    on_new_channel: function (channel) {
        this.render_sidebar();
        if (channel.autoswitch) {
            this.set_channel(channel);
        }
    },
    on_composer_input_focused: function () {
        var suggestions = chat_manager.get_mention_partner_suggestions(this.channel);
        var composer = this.channel.mass_mailing ? this.extended_composer : this.basic_composer;
        composer.mention_set_prefetched_partners(suggestions);
    },

    on_click_button_invite: function () {
        var title = _.str.sprintf(_t('Invite people to %s'), this.channel.name);
        new PartnerInviteDialog(this, title, this.channel.id).open();
    },
    on_click_button_detach: function () {
        chat_manager.detach_channel(this.channel);
    },

    on_click_button_unsubscribe: function () {
        this.unsubscribe_from_channel(this.channel);
    },
    on_click_button_settings: function() {
        this.do_action({
            type: 'ir.actions.act_window',
            res_model: "mail.channel",
            res_id: this.channel.id,
            views: [[false, 'form']],
            target: 'current'
        });
    },
});


core.action_registry.add('mail.chat.instant_messaging', ChatAction);

});
