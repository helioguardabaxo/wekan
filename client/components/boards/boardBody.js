import { ReactiveCache } from '/imports/reactiveCache';
import { TAPi18n } from '/imports/i18n';
import dragscroll from '@wekanteam/dragscroll';

const subManager = new SubsManager();
const { calculateIndex } = Utils;
const swimlaneWhileSortingHeight = 150;

BlazeComponent.extendComponent({
  onCreated() {
    this.isBoardReady = new ReactiveVar(false);

    // The pattern we use to manually handle data loading is described here:
    // https://kadira.io/academy/meteor-routing-guide/content/subscriptions-and-data-management/using-subs-manager
    // XXX The boardId should be readed from some sort the component "props",
    // unfortunatly, Blaze doesn't have this notion.
    this.autorun(() => {
      const currentBoardId = Session.get('currentBoard');
      if (!currentBoardId) return;
      const handle = subManager.subscribe('board', currentBoardId, false);
      Tracker.nonreactive(() => {
        Tracker.autorun(() => {
          this.isBoardReady.set(handle.ready());
        });
      });
    });
  },

  onlyShowCurrentCard() {
    return Utils.isMiniScreen() && Utils.getCurrentCardId(true);
  },

  goHome() {
    FlowRouter.go('home');
  },
}).register('board');

BlazeComponent.extendComponent({
  onCreated() {
    Meteor.subscribe('tableVisibilityModeSettings');
    this.showOverlay = new ReactiveVar(false);
    this.draggingActive = new ReactiveVar(false);
    this._isDragging = false;
    // Used to set the overlay
    this.mouseHasEnterCardDetails = false;

    // fix swimlanes sort field if there are null values
    const currentBoardData = Utils.getCurrentBoard();
    const nullSortSwimlanes = currentBoardData.nullSortSwimlanes();
    if (nullSortSwimlanes.length > 0) {
      const swimlanes = currentBoardData.swimlanes();
      let count = 0;
      swimlanes.forEach(s => {
        Swimlanes.update(s._id, {
          $set: {
            sort: count,
          },
        });
        count += 1;
      });
    }

    // fix lists sort field if there are null values
    const nullSortLists = currentBoardData.nullSortLists();
    if (nullSortLists.length > 0) {
      const lists = currentBoardData.lists();
      let count = 0;
      lists.forEach(l => {
        Lists.update(l._id, {
          $set: {
            sort: count,
          },
        });
        count += 1;
      });
    }
  },
  onRendered() {
    const boardComponent = this;
    const $swimlanesDom = boardComponent.$('.js-swimlanes');

    $swimlanesDom.sortable({
      tolerance: 'pointer',
      appendTo: '.board-canvas',
      helper(evt, item) {
        const helper = $(`<div class="swimlane"
                               style="flex-direction: column;
                                      height: ${swimlaneWhileSortingHeight}px;
                                      width: $(boardComponent.width)px;
                                      overflow: hidden;"/>`);
        helper.append(item.clone());
        // Also grab the list of lists of cards
        const list = item.next();
        helper.append(list.clone());
        return helper;
      },
      items: '.swimlane:not(.placeholder)',
      placeholder: 'swimlane placeholder',
      distance: 7,
      start(evt, ui) {
        const listDom = ui.placeholder.next('.js-swimlane');
        const parentOffset = ui.item.parent().offset();

        ui.placeholder.height(ui.helper.height());
        EscapeActions.executeUpTo('popup-close');
        listDom.addClass('moving-swimlane');
        boardComponent.setIsDragging(true);

        ui.placeholder.insertAfter(ui.placeholder.next());
        boardComponent.origPlaceholderIndex = ui.placeholder.index();

        // resize all swimlanes + headers to be a total of 150 px per row
        // this could be achieved by setIsDragging(true) but we want immediate
        // result
        ui.item
          .siblings('.js-swimlane')
          .css('height', `${swimlaneWhileSortingHeight - 26}px`);

        // set the new scroll height after the resize and insertion of
        // the placeholder. We want the element under the cursor to stay
        // at the same place on the screen
        ui.item.parent().get(0).scrollTop =
          ui.placeholder.get(0).offsetTop + parentOffset.top - evt.pageY;
      },
      beforeStop(evt, ui) {
        const parentOffset = ui.item.parent().offset();
        const siblings = ui.item.siblings('.js-swimlane');
        siblings.css('height', '');

        // compute the new scroll height after the resize and removal of
        // the placeholder
        const scrollTop =
          ui.placeholder.get(0).offsetTop + parentOffset.top - evt.pageY;

        // then reset the original view of the swimlane
        siblings.removeClass('moving-swimlane');

        // and apply the computed scrollheight
        ui.item.parent().get(0).scrollTop = scrollTop;
      },
      stop(evt, ui) {
        // To attribute the new index number, we need to get the DOM element
        // of the previous and the following card -- if any.
        const prevSwimlaneDom = ui.item.prevAll('.js-swimlane').get(0);
        const nextSwimlaneDom = ui.item.nextAll('.js-swimlane').get(0);
        const sortIndex = calculateIndex(prevSwimlaneDom, nextSwimlaneDom, 1);

        $swimlanesDom.sortable('cancel');
        const swimlaneDomElement = ui.item.get(0);
        const swimlane = Blaze.getData(swimlaneDomElement);

        Swimlanes.update(swimlane._id, {
          $set: {
            sort: sortIndex.base,
          },
        });

        boardComponent.setIsDragging(false);
      },
      sort(evt, ui) {
        // get the mouse position in the sortable
        const parentOffset = ui.item.parent().offset();
        const cursorY =
          evt.pageY - parentOffset.top + ui.item.parent().scrollTop();

        // compute the intended index of the placeholder (we need to skip the
        // slots between the headers and the list of cards)
        const newplaceholderIndex = Math.floor(
          cursorY / swimlaneWhileSortingHeight,
        );
        let destPlaceholderIndex = (newplaceholderIndex + 1) * 2;

        // if we are scrolling far away from the bottom of the list
        if (destPlaceholderIndex >= ui.item.parent().get(0).childElementCount) {
          destPlaceholderIndex = ui.item.parent().get(0).childElementCount - 1;
        }

        // update the placeholder position in the DOM tree
        if (destPlaceholderIndex !== ui.placeholder.index()) {
          if (destPlaceholderIndex < boardComponent.origPlaceholderIndex) {
            ui.placeholder.insertBefore(
              ui.placeholder
                .siblings()
                .slice(destPlaceholderIndex - 2, destPlaceholderIndex - 1),
            );
          } else {
            ui.placeholder.insertAfter(
              ui.placeholder
                .siblings()
                .slice(destPlaceholderIndex - 1, destPlaceholderIndex),
            );
          }
        }
      },
    });

    this.autorun(() => {
      // Always reset dragscroll on view switch
      dragscroll.reset();

      if (Utils.isTouchScreenOrShowDesktopDragHandles()) {
        $swimlanesDom.sortable({
          handle: '.js-swimlane-header-handle',
        });
      } else {
        $swimlanesDom.sortable({
          handle: '.swimlane-header',
        });
      }

      // Disable drag-dropping if the current user is not a board member
      $swimlanesDom.sortable(
        'option',
        'disabled',
        !ReactiveCache.getCurrentUser()?.isBoardAdmin(),
      );
    });

    // If there is no data in the board (ie, no lists) we autofocus the list
    // creation form by clicking on the corresponding element.
    const currentBoard = Utils.getCurrentBoard();
    if (Utils.canModifyBoard() && currentBoard.lists().length === 0) {
      boardComponent.openNewListForm();
    }

    dragscroll.reset();
    Utils.setBackgroundImage();
  },

  notDisplayThisBoard() {
    let allowPrivateVisibilityOnly = TableVisibilityModeSettings.findOne('tableVisibilityMode-allowPrivateOnly');
    let currentBoard = Utils.getCurrentBoard();
    if (allowPrivateVisibilityOnly !== undefined && allowPrivateVisibilityOnly.booleanValue && currentBoard.permission == 'public') {
      return true;
    }

    return false;
  },

  isViewSwimlanes() {
    const currentUser = ReactiveCache.getCurrentUser();
    if (currentUser) {
      return (currentUser.profile || {}).boardView === 'board-view-swimlanes';
    } else {
      return (
        window.localStorage.getItem('boardView') === 'board-view-swimlanes'
      );
    }
  },

  hasSwimlanes() {
    return Utils.getCurrentBoard().swimlanes().length > 0;
  },

  isViewLists() {
    const currentUser = ReactiveCache.getCurrentUser();
    if (currentUser) {
      return (currentUser.profile || {}).boardView === 'board-view-lists';
    } else {
      return window.localStorage.getItem('boardView') === 'board-view-lists';
    }
  },

  isViewCalendar() {
    const currentUser = ReactiveCache.getCurrentUser();
    if (currentUser) {
      return (currentUser.profile || {}).boardView === 'board-view-cal';
    } else {
      return window.localStorage.getItem('boardView') === 'board-view-cal';
    }
  },

  isVerticalScrollbars() {
    const user = ReactiveCache.getCurrentUser();
    return user && user.isVerticalScrollbars();
  },

  openNewListForm() {
    if (this.isViewSwimlanes()) {
      // The form had been removed in 416b17062e57f215206e93a85b02ef9eb1ab4902
      // this.childComponents('swimlane')[0]
      //   .childComponents('addListAndSwimlaneForm')[0]
      //   .open();
    } else if (this.isViewLists()) {
      this.childComponents('listsGroup')[0]
        .childComponents('addListForm')[0]
        .open();
    }
  },
  events() {
    return [
      {
        // XXX The board-overlay div should probably be moved to the parent
        // component.
        mouseup() {
          if (this._isDragging) {
            this._isDragging = false;
          }
        },
        'click .js-empty-board-add-swimlane': Popup.open('swimlaneAdd'),
      },
    ];
  },

  // XXX Flow components allow us to avoid creating these two setter methods by
  // exposing a public API to modify the component state. We need to investigate
  // best practices here.
  setIsDragging(bool) {
    this.draggingActive.set(bool);
  },

  scrollLeft(position = 0) {
    const swimlanes = this.$('.js-swimlanes');
    swimlanes &&
      swimlanes.animate({
        scrollLeft: position,
      });
  },

  scrollTop(position = 0) {
    const swimlanes = this.$('.js-swimlanes');
    swimlanes &&
      swimlanes.animate({
        scrollTop: position,
      });
  },
}).register('boardBody');

BlazeComponent.extendComponent({
  onRendered() {
    this.autorun(function () {
      $('#calendar-view').fullCalendar('refetchEvents');
    });
  },
  calendarOptions() {
    return {
      id: 'calendar-view',
      defaultView: 'month',
      editable: true,
      selectable: true,
      timezone: 'local',
      weekNumbers: true,
      header: {
        left: 'title   today prev,next',
        center:
          'agendaDay,listDay,timelineDay agendaWeek,listWeek,timelineWeek month,listMonth',
        right: '',
      },
      // height: 'parent', nope, doesn't work as the parent might be small
      height: 'auto',
      /* TODO: lists as resources: https://fullcalendar.io/docs/vertical-resource-view */
      navLinks: true,
      nowIndicator: true,
      businessHours: {
        // days of week. an array of zero-based day of week integers (0=Sunday)
        dow: [1, 2, 3, 4, 5], // Monday - Friday
        start: '8:00',
        end: '18:00',
      },
      locale: TAPi18n.getLanguage(),
      events(start, end, timezone, callback) {
        const currentBoard = Utils.getCurrentBoard();
        const events = [];
        const pushEvent = function (card, title, start, end, extraCls) {
          start = start || card.startAt;
          end = end || card.endAt;
          title = title || card.title;
          const className =
            (extraCls ? `${extraCls} ` : '') +
            (card.color ? `calendar-event-${card.color}` : '');
          events.push({
            id: card._id,
            title,
            start,
            end: end || card.endAt,
            allDay:
              Math.abs(end.getTime() - start.getTime()) / 1000 === 24 * 3600,
            url: FlowRouter.path('card', {
              boardId: currentBoard._id,
              slug: currentBoard.slug,
              cardId: card._id,
            }),
            className,
          });
        };
        currentBoard
          .cardsInInterval(start.toDate(), end.toDate())
          .forEach(function (card) {
            pushEvent(card);
          });
        currentBoard
          .cardsDueInBetween(start.toDate(), end.toDate())
          .forEach(function (card) {
            pushEvent(
              card,
              `${card.title} ${TAPi18n.__('card-due')}`,
              card.dueAt,
              new Date(card.dueAt.getTime() + 36e5),
            );
          });
        events.sort(function (first, second) {
          return first.id > second.id ? 1 : -1;
        });
        callback(events);
      },
      eventResize(event, delta, revertFunc) {
        let isOk = false;
        const card = ReactiveCache.getCard(event.id);

        if (card) {
          card.setEnd(event.end.toDate());
          isOk = true;
        }
        if (!isOk) {
          revertFunc();
        }
      },
      eventDrop(event, delta, revertFunc) {
        let isOk = false;
        const card = ReactiveCache.getCard(event.id);
        if (card) {
          // TODO: add a flag for allDay events
          if (!event.allDay) {
            // https://github.com/wekan/wekan/issues/2917#issuecomment-1236753962
            //card.setStart(event.start.toDate());
            //card.setEnd(event.end.toDate());
            card.setDue(event.start.toDate());
            isOk = true;
          }
        }
        if (!isOk) {
          revertFunc();
        }
      },
      select: function (startDate) {
        const currentBoard = Utils.getCurrentBoard();
        const currentUser = ReactiveCache.getCurrentUser();
        const modalElement = document.createElement('div');
        modalElement.classList.add('modal', 'fade');
        modalElement.setAttribute('tabindex', '-1');
        modalElement.setAttribute('role', 'dialog');
        modalElement.innerHTML = `
        <div class="modal-dialog justify-content-center align-items-center" role="document">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">${TAPi18n.__('r-create-card')}</h5>
              <button type="button" class="close" data-dismiss="modal" aria-label="Close">
                <span aria-hidden="true">&times;</span>
              </button>
            </div>
            <div class="modal-body text-center">
              <input type="text" class="form-control" id="card-title-input" placeholder="">
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-primary" id="create-card-button">${TAPi18n.__('add-card')}</button>
            </div>
          </div>
        </div>
        `;
        const createCardButton = modalElement.querySelector('#create-card-button');
        createCardButton.addEventListener('click', function () {
          const myTitle = modalElement.querySelector('#card-title-input').value;
          if (myTitle) {
            const firstList = currentBoard.draggableLists()[0];
            const firstSwimlane = currentBoard.swimlanes()[0];
            Meteor.call('createCardWithDueDate', currentBoard._id, firstList._id, myTitle, startDate.toDate(), firstSwimlane._id, function(error, result) {
              if (error) {
                console.log(error);
              } else {
                console.log("Card Created", result);
              }
            });
            closeModal();
          }
        });
        document.body.appendChild(modalElement);
        const openModal = function() {
          modalElement.style.display = 'flex';
        };
        const closeModal = function() {
          modalElement.style.display = 'none';
        };
        const closeButton = modalElement.querySelector('[data-dismiss="modal"]');
        closeButton.addEventListener('click', closeModal);
        openModal();
      }
    };
  },
  isViewCalendar() {
    const currentUser = ReactiveCache.getCurrentUser();
    if (currentUser) {
      return (currentUser.profile || {}).boardView === 'board-view-cal';
    } else {
      return window.localStorage.getItem('boardView') === 'board-view-cal';
    }
  },
}).register('calendarView');
